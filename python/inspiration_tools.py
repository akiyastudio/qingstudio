"""Dispatcher for the visual tools bundled with PhotoFlow's core app."""

import importlib
import json
import sys


TOOLS = {
    "research": "research",
    "office_media_extract": "office_media_extract",
    "screenshot_main_image": "screenshot_main_image",
}


def _error(code, message, **details):
    error = {"code": code, "message": message}
    error.update(details)
    print(json.dumps({"type": "error", "message": message, "success": False, "error": error}, ensure_ascii=True), flush=True)
    return 2


def main(args_list):
    if not args_list:
        return _error("missing_tool", "请指定灵感库工具名称")
    tool_name, *tool_args = args_list
    tool_name = tool_name.removesuffix(".py")
    try:
        module_name = TOOLS[tool_name]
    except KeyError:
        return _error("unknown_tool", f"未知灵感库工具：{tool_name}", tool=tool_name)
    try:
        module = importlib.import_module(module_name)
    except Exception as error:
        return _error("import_failed", f"无法加载灵感库工具：{tool_name}", tool=tool_name, detail=str(error))
    try:
        module.run(tool_args)
    except SystemExit as error:
        return _error(
            "invalid_arguments",
            f"灵感库工具参数无效：{tool_name}",
            tool=tool_name,
            exitCode=error.code if isinstance(error.code, int) else 2,
        )
    except Exception as error:
        return _error("tool_failed", f"灵感库工具运行失败：{tool_name}", tool=tool_name, detail=str(error))
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main(sys.argv[1:]))
