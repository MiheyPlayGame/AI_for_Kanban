from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://assistant_user:assistant_pass@localhost:5432/assistant_db"

    jwt_secret: str = "very_insecure_secret"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 60
    refresh_token_minutes: int = 60 * 24 * 7

    hf_token: str = ""
    hf_model: str = "HuggingFaceH4/zephyr-7b-beta"
    notion_client_id: str = ""
    notion_client_secret: str = ""
    notion_redirect_uri: str = ""
    notion_oauth_state_ttl_minutes: int = 10

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


settings = Settings()
