from huggingface_hub import InferenceClient

from app.config import settings
from app.models import Message


def build_prompt(history: list[Message], new_user_message: str) -> str:
    lines = [
        "You are a helpful assistant. Keep answers concise.",
    ]
    for msg in history:
        prefix = "User" if msg.role == "user" else "Assistant"
        lines.append(f"{prefix}: {msg.content}")
    lines.append(f"User: {new_user_message}")
    lines.append("Assistant:")
    return "\n".join(lines)


def generate_assistant_reply(history: list[Message], new_user_message: str) -> str:
    if not settings.hf_token:
        return "HF_TOKEN is not configured. Message stored without model response."

    client = InferenceClient(model=settings.hf_model, token=settings.hf_token)
    prompt = build_prompt(history, new_user_message)

    response = client.text_generation(
        prompt=prompt,
        max_new_tokens=300,
        temperature=0.7,
        do_sample=True,
        return_full_text=False,
    )
    return response.strip() if response else ""
