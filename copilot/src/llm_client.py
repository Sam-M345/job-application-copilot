import json
import typing
from typing import Type, TypeVar

from anthropic import Anthropic
from pydantic import BaseModel, ValidationError

from .config import get_settings
from . import run_log

T = TypeVar("T", bound=BaseModel)

_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic(api_key=get_settings().anthropic_api_key)
    return _client


def _message_text(response) -> str:
    parts: list[str] = []
    block_types: list[str] = []
    for block in response.content:
        block_type = getattr(block, "type", type(block).__name__)
        block_types.append(str(block_type))
        if block_type == "text":
            parts.append(block.text)
        elif block_type == "thinking":
            continue
        elif hasattr(block, "text"):
            parts.append(block.text)
    if not parts:
        raise ValueError(
            "No text block in model response. "
            f"Content block types: {block_types}"
        )
    return "\n".join(parts).strip()


def _strip_json_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        text = text[first_newline + 1 :] if first_newline != -1 else text[3:]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text.strip()


def _model_shape(model: type[BaseModel]) -> dict[str, object]:
    return {
        name: _placeholder_for(field.annotation)
        for name, field in model.model_fields.items()
    }


def _placeholder_for(annotation: object) -> object:
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return _model_shape(annotation)

    origin = typing.get_origin(annotation)
    if origin is list:
        args = typing.get_args(annotation)
        if args:
            inner = args[0]
            if isinstance(inner, type) and issubclass(inner, BaseModel):
                return [_model_shape(inner)]
        return []
    if origin is dict:
        return {}
    if origin is typing.Literal:
        args = typing.get_args(annotation)
        return args[0] if args else ""
    if annotation is bool:
        return False
    if annotation is int:
        return 0
    if annotation is float:
        return 0.0
    return "string"


def _json_response_instruction(response_model: Type[BaseModel]) -> str:
    keys = list(response_model.model_fields.keys())
    shape = {
        name: _placeholder_for(field.annotation)
        for name, field in response_model.model_fields.items()
    }
    allowed_lines: list[str] = []
    for name, field in response_model.model_fields.items():
        origin = typing.get_origin(field.annotation)
        if origin is typing.Literal:
            values = ", ".join(repr(arg) for arg in typing.get_args(field.annotation))
            allowed_lines.append(f"- {name} must be exactly one of: {values}")
        if origin is list:
            args = typing.get_args(field.annotation)
            if args and isinstance(args[0], type) and issubclass(args[0], BaseModel):
                allowed_lines.append(
                    f"- {name} must be a list of objects (not strings). "
                    f"Each item needs keys: {', '.join(args[0].model_fields.keys())}"
                )
    allowed_block = ""
    if allowed_lines:
        allowed_block = "\nAllowed values:\n" + "\n".join(allowed_lines) + "\n"
    return (
        "\n\nRespond ONLY with one JSON object. "
        "Return data values, not a JSON schema. "
        "Do not include keys named properties, $defs, or type. "
        "Do not use markdown or explanation.\n"
        f"Required keys: {', '.join(keys)}\n"
        f"{allowed_block}"
        f"Example:\n{json.dumps(shape, indent=2)}"
    )


def _extract_json_object(text: str) -> str:
    text = _strip_json_fences(text)
    try:
        json.loads(text)
        return text
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    if start == -1:
        raise ValueError("No JSON object found in model response.")

    depth = 0
    in_string = False
    escape = False
    for index, char in enumerate(text[start:], start):
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]

    raise ValueError("No complete JSON object found in model response.")


def _parse_model_json(response_model: Type[T], raw_text: str) -> T:
    payload = _extract_json_object(raw_text)
    return response_model.model_validate_json(payload)


def call_llm_json(
    prompt: str,
    response_model: Type[T],
    *,
    system: str | None = None,
    max_tokens: int = 4096,
    step: str = "call_llm_json",
) -> T:
    settings = get_settings()
    instruction = _json_response_instruction(response_model)
    kwargs: dict = {
        "model": settings.anthropic_model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt + instruction}],
    }
    if system:
        kwargs["system"] = system

    client = _get_client()

    def _call_and_parse(create_kwargs: dict) -> T:
        response = client.messages.create(**create_kwargs)
        raw_text = _message_text(response)
        return _parse_model_json(response_model, raw_text), raw_text

    try:
        parsed, _ = _call_and_parse(kwargs)
        return parsed
    except (ValidationError, ValueError, AttributeError) as exc:
        raw_text = ""
        try:
            response = client.messages.create(**kwargs)
            raw_text = _message_text(response)
        except Exception:
            pass
        run_log.log_llm_failure(
            step=step,
            model=settings.anthropic_model,
            error=exc,
            raw_response=raw_text,
        )
        retry_kwargs = {
            **kwargs,
            "messages": [
                {
                    "role": "user",
                    "content": (
                        prompt
                        + instruction
                        + "\n\nYour previous reply was invalid JSON. "
                        "Reply again with only one JSON object containing data values."
                    ),
                }
            ],
        }
        try:
            parsed, _ = _call_and_parse(retry_kwargs)
            run_log.log_info(f"LLM retry succeeded at {step}")
            return parsed
        except Exception as retry_exc:
            retry_raw = ""
            try:
                response = client.messages.create(**retry_kwargs)
                retry_raw = _message_text(response)
            except Exception:
                pass
            run_log.log_llm_failure(
                step=f"{step} (retry)",
                model=settings.anthropic_model,
                error=retry_exc,
                raw_response=retry_raw,
            )
            raise


def call_llm_text(
    prompt: str,
    *,
    system: str | None = None,
    max_tokens: int = 2048,
    step: str = "call_llm_text",
) -> str:
    settings = get_settings()
    kwargs: dict = {
        "model": settings.anthropic_model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if system:
        kwargs["system"] = system
    try:
        response = _get_client().messages.create(**kwargs)
        return _message_text(response)
    except Exception as exc:
        run_log.log_llm_failure(step=step, model=settings.anthropic_model, error=exc)
        raise
