from typing import Any

from . import run_log
from .state import GraphState, TraceEntry


def append_trace(state: GraphState, step: str, status: str, message: str) -> list[TraceEntry]:
    trace = list(state.get("trace") or [])
    trace.append({"step": step, "status": status, "message": message})
    return trace


def halt(state: GraphState, step: str, message: str) -> dict[str, Any]:
    run_log.log_error(f"[{step}] {message}")
    return {
        "halted": True,
        "halt_reason": message,
        "trace": append_trace(state, step, "halted", message),
    }


def pass_step(state: GraphState, step: str, message: str) -> list[TraceEntry]:
    return append_trace(state, step, "passed", message)
