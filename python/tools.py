import importlib
import sys

from compatibility.registry import tool_modules


TOOLS = {
    "catch": "catch",
    "classify": "classify",
    "png_to_jpg": "png_to_jpg",
    "raw_decoder": "raw_decoder",
    "rename": "rename",
    "thumbnail_db": "thumbnail_db",
    "thumbnail_image": "thumbnail_image",
    "workspace_db": "workspace_db",
    "operations_db": "operations_db",
    "backup_db": "backup_db",
}
TOOLS.update(tool_modules())


def main(args_list):
    if not args_list:
        raise SystemExit("请指定工具名称")

    tool_name, *tool_args = args_list
    tool_name = tool_name.removesuffix(".py")
    try:
        module_name = TOOLS[tool_name]
    except KeyError:
        raise SystemExit(f"未知工具：{tool_name}") from None
    importlib.import_module(module_name).run(tool_args)


if __name__ == "__main__":
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    main(sys.argv[1:])
