from langgraph.graph import END, StateGraph

from .nodes import (
    analyze_fit,
    detect_job_type,
    document_completeness_gate,
    format_report,
    index_evidence,
    location_gate,
    parse_documents,
    relevance_gate,
    reset_evidence_index,
)
from .state import GraphState


def _route_after_gate(state: GraphState) -> str:
    if state.get("halted"):
        return "format_report"
    return "continue"


def build_graph():
    reset_evidence_index()
    graph = StateGraph(GraphState)

    graph.add_node("parse_documents", parse_documents)
    graph.add_node("detect_job_type", detect_job_type)
    graph.add_node("document_completeness_gate", document_completeness_gate)
    graph.add_node("location_gate", location_gate)
    graph.add_node("relevance_gate", relevance_gate)
    graph.add_node("index_evidence", index_evidence)
    graph.add_node("analyze_fit", analyze_fit)
    graph.add_node("format_report", format_report)

    graph.set_entry_point("parse_documents")
    graph.add_edge("parse_documents", "detect_job_type")
    graph.add_edge("detect_job_type", "document_completeness_gate")

    graph.add_conditional_edges(
        "document_completeness_gate",
        _route_after_gate,
        {"continue": "location_gate", "format_report": "format_report"},
    )
    graph.add_conditional_edges(
        "location_gate",
        _route_after_gate,
        {"continue": "relevance_gate", "format_report": "format_report"},
    )
    graph.add_conditional_edges(
        "relevance_gate",
        _route_after_gate,
        {"continue": "index_evidence", "format_report": "format_report"},
    )
    graph.add_edge("index_evidence", "analyze_fit")
    graph.add_conditional_edges(
        "analyze_fit",
        _route_after_gate,
        {"continue": "format_report", "format_report": "format_report"},
    )
    graph.add_edge("format_report", END)

    return graph.compile()


def run_analysis(initial_state: GraphState) -> GraphState:
    reset_evidence_index()
    app = build_graph()
    return app.invoke(initial_state)
