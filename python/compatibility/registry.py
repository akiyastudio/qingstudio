"""Generic discovery and registries for deprecated Python runtime contracts."""

from __future__ import annotations

import importlib
import pkgutil
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable


ActionHandler = Callable[[str, Any, dict], dict]
Hook = Callable[..., Any]


@dataclass
class LegacyDomain:
    actions: dict[str, ActionHandler] = field(default_factory=dict)
    integrated_actions: set[str] = field(default_factory=set)
    hooks: dict[str, list[Hook]] = field(default_factory=lambda: defaultdict(list))


_domains: list[LegacyDomain] = []
_tools: dict[str, str] = {}
_exports: dict[str, dict[str, Any]] = {}
_discovered = False


def register_domain(domain: LegacyDomain) -> None:
    _domains.append(domain)


def register_tool(name: str, module: str) -> None:
    if name in _tools:
        raise RuntimeError(f"duplicate compatibility tool: {name}")
    _tools[name] = module


def register_exports(role: str, values: dict[str, Any]) -> None:
    _exports.setdefault(role, {}).update(values)


def legacy_exports(role: str) -> dict[str, Any]:
    discover()
    return dict(_exports.get(role) or {})


def resolve_export(name: str):
    discover()
    for values in _exports.values():
        if name in values:
            return values[name]
    raise AttributeError(name)


def discover() -> None:
    global _discovered
    if _discovered:
        return
    _discovered = True
    package = importlib.import_module(__package__)
    for module in pkgutil.iter_modules(package.__path__, f"{__package__}."):
        if module.ispkg:
            importlib.import_module(module.name)


def action_names() -> tuple[str, ...]:
    discover()
    return tuple(action for domain in _domains for action in domain.actions)


def integrated_action_names() -> frozenset[str]:
    discover()
    return frozenset(action for domain in _domains for action in domain.integrated_actions)


def has_action(action: str) -> bool:
    return action in action_names()


def dispatch_action(action: str, root: str, db, payload: dict):
    discover()
    for domain in _domains:
        handler = domain.actions.get(action)
        if handler is not None:
            return handler(root, db, payload)
    raise KeyError(action)


def run_hooks(name: str, *args, **kwargs) -> list[Any]:
    discover()
    return [hook(*args, **kwargs) for domain in _domains for hook in domain.hooks.get(name, ())]


def tool_modules() -> dict[str, str]:
    discover()
    return dict(_tools)
