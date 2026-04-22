import threading
from typing import Any

from huggingface_hub import InferenceClient
from huggingface_hub.errors import BadRequestError, HfHubHTTPError

from app.config import settings
from app.models import Message

_SYSTEM = "You are a helpful assistant. Keep answers concise."

_local_lock = threading.Lock()
_local_processor: Any = None
_local_model: Any = None


def build_chat_messages(history: list[Message], new_user_message: str) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = [{"role": "system", "content": _SYSTEM}]
    for msg in history:
        messages.append({"role": msg.role, "content": msg.content})
    messages.append({"role": "user", "content": new_user_message})
    return messages


def _load_local_gemma() -> tuple[Any, Any]:
    global _local_processor, _local_model

    if _local_model is not None:
        return _local_processor, _local_model

    try:
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor
    except ImportError:
        raise RuntimeError(
            "Install local LLM dependencies: pip install -r requirements-llm.txt"
        ) from None

    import transformers

    model_id = settings.hf_model
    token = settings.hf_token or None
    processor = AutoProcessor.from_pretrained(model_id, token=token)
    load_kw: dict[str, Any] = {"token": token}
    major, minor = (int(x) for x in transformers.__version__.split(".", 2)[:2])
    dtype_key = "dtype" if (major, minor) >= (5, 0) else "torch_dtype"
    if torch.cuda.is_available():
        load_kw["device_map"] = "auto"
        load_kw[dtype_key] = torch.bfloat16
    else:
        load_kw[dtype_key] = torch.float32

    model = AutoModelForImageTextToText.from_pretrained(model_id, **load_kw)
    if not torch.cuda.is_available():
        model = model.to("cpu")
    model.eval()
    _local_processor = processor
    _local_model = model
    return processor, model


def _generate_local(messages: list[dict[str, str]]) -> str:
    import torch

    with _local_lock:
        processor, model = _load_local_gemma()
        inputs = processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        )
        device = next(model.parameters()).device
        inputs = {k: v.to(device) if torch.is_tensor(v) else v for k, v in inputs.items()}

        tokenizer = getattr(processor, "tokenizer", processor)
        pad_id = tokenizer.pad_token_id
        if pad_id is None:
            pad_id = tokenizer.eos_token_id

        with torch.inference_mode():
            generated = model.generate(
                **inputs,
                max_new_tokens=300,
                do_sample=True,
                temperature=0.7,
                pad_token_id=pad_id,
            )

        prompt_len = inputs["input_ids"].shape[-1]
        new_tokens = generated[0, prompt_len:]
        return tokenizer.decode(new_tokens, skip_special_tokens=True).strip()


def generate_assistant_reply(history: list[Message], new_user_message: str) -> str:
    if not settings.hf_token:
        return "HF_TOKEN is not configured. Message stored without model response."

    messages = build_chat_messages(history, new_user_message)

    if settings.hf_local_transformers:
        try:
            return _generate_local(messages)
        except RuntimeError as exc:
            return str(exc)
        except Exception as exc:
            return f"Local model error: {exc}"

    client_kw: dict[str, Any] = {"model": settings.hf_model, "token": settings.hf_token}
    prov = (settings.hf_inference_provider or "").strip()
    if prov:
        client_kw["provider"] = prov
    client = InferenceClient(**client_kw)

    try:
        response = client.chat_completion(
            messages=messages,
            max_tokens=300,
            temperature=0.7,
        )
    except StopIteration:
        return (
            "No Hugging Face Inference Provider hosts HF_MODEL yet. "
            "Use a model with Inference support on its model card, set HF_MODEL to your Inference Endpoints URL, "
            "or enable HF_LOCAL_TRANSFORMERS=1 with pip install -r requirements-llm.txt for Gemma 4."
        )
    except BadRequestError as exc:
        return (
            f"Hugging Face Inference rejected the request ({exc}). "
            "Try setting HF_INFERENCE_PROVIDER to a provider you enabled (e.g. featherless-ai), or adjust HF_MODEL."
        )
    except HfHubHTTPError as exc:
        return f"Hugging Face Inference HTTP error: {exc}"
    except ValueError as exc:
        msg = str(exc)
        if "doesn't support task" in msg or "not supported by provider" in msg:
            return (
                f"Inference API cannot run this model as chat ({msg}). "
                "Try HF_MODEL=google/gemma-2-9b-it, a deployed endpoint URL, or HF_LOCAL_TRANSFORMERS=1 for Gemma 4."
            )
        return f"Hugging Face client value error: {msg}"
    except Exception as exc:
        return f"Hugging Face unexpected error: {exc}"
    if not response.choices:
        return ""
    content = response.choices[0].message.content
    return content.strip() if content else ""
