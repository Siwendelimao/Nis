"""
LLM 工具定义 — 对齐 opencode 结构化工具调用。

框架层确定性触发（权限/询问不再靠 markdown）：
- clarify：结构化询问工具，LLM 调用 {questions:[{question, choices, multiple, custom}]}
- gateway 工具：shell/代码/文件等真实工具，执行前经 ToolGateway.execute → GateKeeper.secure_call
  确定性触发权限卡（本次允许/当前会话允许/当前项目允许/拒绝）。

仅提供 name/description/parameters 最小 schema，供 litellm 注入 tools。
"""

from __future__ import annotations

from typing import Any, Optional

# ── 询问工具：clarify ─────────────────────────────────────────────
CLARIFY_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "clarify",
        "description": (
            "向用户提出一个或多个问题来确认需求、澄清歧义或收集必要信息。"
            "仅在确实缺少必要信息、且无法基于合理假设继续时使用；"
            "能合理推断或有默认做法就直接继续做，不要为细节反复提问。"
            "一次调用可批量提多个问题，用户会一次性作答。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description": "要向用户提出的问题列表（批量）",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {
                                "type": "string",
                                "description": "完整问题",
                            },
                            "choices": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "可选答案（可省略，省略则用户自由输入）",
                            },
                            "multiple": {
                                "type": "boolean",
                                "description": "是否允许多选（默认 false）",
                            },
                            "custom": {
                                "type": "boolean",
                                "description": "是否允许自定义输入（默认 true）",
                            },
                        },
                        "required": ["question"],
                    },
                }
            },
            "required": ["questions"],
        },
    },
}

# ── gateway 工具 → LLM 描述映射（风险权限由 gate_keeper 兜底，不在此暴露）────────
GATEWAY_TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    # ── 召集伙伴（流程模式核心，v3：AI 正常对话沟通需求，需求明确后主动召集）──
    "request_partners": {
        "name": "request_partners",
        "description": (
            "召集项目伙伴协作（流程模式核心）：当用户提出的需求已经明确、且需要多个项目成员分工完成时调用。"
            "调用后系统会向用户展示一张确认卡（列出需要的伙伴、技能与任务），用户同意后自动进入任务规划、"
            "黑板派发与结果汇总。\n"
            "重要：普通聊天、问答、小改动不要调用；先与用户用正常对话沟通需求，"
            "只有当需求明确需要伙伴分工协作时才调用本工具。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "完整任务描述（用户需求原文 + 你的理解，供伙伴分工与黑板派发使用）",
                },
                "partners": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "（可选）指定需要的伙伴 id；不填则系统按任务语义从项目启用成员中自动挑选",
                },
            },
            "required": ["task"],
        },
    },
    # ── 子代理：task（多 agent 核心，opencode 协议对齐）─────────────────
    "task": {
        "name": "task",
        "description": (
            "把任务委托给一个子代理去完成（多 agent 协作）。适合：需要独立调查/搜索/阅读大量代码的任务，"
            "或与当前主线并行推进的子任务。调用后子代理会在独立上下文中工作，返回结构化结果。"
            "简单任务不要用——直接自己用工具完成更快；只有任务确实独立且复杂时才委托。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "给子代理的完整任务指令（说明目标、上下文要点、期望输出格式；开头注明任务类型——编码/测试/文档/前端/搜索等，系统会据此匹配伙伴）",
                },
                "description": {
                    "type": "string",
                    "description": "任务简述（展示用，可选）",
                },
                "partner": {
                    "type": "string",
                    "description": "（可选）指定伙伴身份执行，如 Luna（代码）、TestPilot（测试）、DocAuthor（文档）、WebSurfer（搜索）、Auditor（审查）、Frontend Expert（前端）。不传则按任务类型自动从项目启用成员中匹配。",
                },
                "subagent_id": {
                    "type": "string",
                    "description": "（可选）沿用某个已派发的子代理（续派任务/追问，同气泡续聊）。首次派发不传。",
                },
                "continue": {
                    "type": "boolean",
                    "description": "（可选，与 subagent_id 配合）true = 给该子代理追加任务继续做；false/缺省 = 新任务。",
                },
            },
            "required": ["prompt"],
        },
    },
    "skill_execute": {
        "name": "skill_execute",
        "description": (
            "执行技能库中已有的技能。内置技能：summarize（文本总结）、code_review（代码审查）。"
            "技能代码经 AST 安全审计（禁止系统级操作），可安全调用。"
            "注意：skill_execute 只能执行「技能库里的技能」；文件/目录/搜索等操作不是技能，"
            "请直接用对应工具（list_dir 列目录、read_file 读文件、search_file 搜文件等），不要用 skill_execute 调用它们。"
            "不知道技能库有哪些技能时，先调用 skill_list 一次列出。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "skill_name": {"type": "string", "description": "技能名：summarize / code_review / skill_list 返回的其它技能名"},
                "args": {
                    "type": "object",
                    "description": "技能参数：summarize 需要 {text, max_len}；code_review 需要 {code}；其它技能按 skill_list 描述传",
                },
            },
            "required": ["skill_name"],
        },
    },
    "plugin_list": {
        "name": "plugin_list",
        "description": (
            "列出当前已注册的插件（插件库内容）及其工具。"
            "用户问有哪些插件/插件库有什么/有没有某类插件时使用；"
            "列出的插件工具名可直接调用（如 screenshot、clipboard_read 等）。"
        ),
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "skill_list": {
        "name": "skill_list",
        "description": (
            "列出技能库中的技能（名称 + 描述）。"
            "用户问有哪些技能/技能库有什么/某个技能是否存在时使用，"
            "找到目标技能后可用 skill_execute 执行。"
        ),
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "shell_exec": {
        "name": "shell_exec",
        "description": "在用户项目环境执行 shell 命令（高风险，需用户授权）。例如安装依赖、运行构建、启动服务等。",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "要执行的 shell 命令"},
                "cwd": {"type": "string", "description": "执行目录（可选）"},
            },
            "required": ["command"],
        },
    },
    "code_search": {
        "name": "code_search",
        "description": "在项目代码库中搜索代码/符号/引用（中风险）。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键字"},
                "path": {"type": "string", "description": "限定目录（可选）"},
            },
            "required": ["query"],
        },
    },
    "diff_edit": {
        "name": "diff_edit",
        "description": "精确替换文件中的指定文本片段（比 write_file 轻量，适合小改动；大改动/不确定原文时用 write_file 重写整个文件）。参数 patches 数组：每项 {file 文件路径(相对项目根), old_text 原文(必须与文件内容逐字一致，含缩进/换行), new_text 替换后的文本}。",
        "parameters": {
            "type": "object",
            "properties": {
                "patches": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "file": {"type": "string", "description": "文件路径（相对项目根目录）"},
                            "old_text": {"type": "string", "description": "要替换的原文，必须与文件内容逐字一致（含缩进）"},
                            "new_text": {"type": "string", "description": "替换后的新文本"},
                        },
                        "required": ["file", "old_text", "new_text"],
                    },
                    "description": "要执行的替换列表",
                }
            },
            "required": ["patches"],
        },
    },
    "git_status": {
        "name": "git_status",
        "description": "查看 git 工作区状态（低风险）。",
        "parameters": {"type": "object", "properties": {}},
    },
    "git_diff": {
        "name": "git_diff",
        "description": "查看 git 变更 diff（低风险）。",
        "parameters": {"type": "object", "properties": {}},
    },
    "git_log": {
        "name": "git_log",
        "description": "查看 git 提交历史（低风险）。",
        "parameters": {"type": "object", "properties": {}},
    },
    "git_commit": {
        "name": "git_commit",
        "description": "创建 git 提交（中风险，需用户授权）。",
        "parameters": {
            "type": "object",
            "properties": {"message": {"type": "string", "description": "提交信息"}},
            "required": ["message"],
        },
    },
    "knowledge_query": {
        "name": "knowledge_query",
        "description": (
            "检索本地知识库（已沉淀的文档/笔记/摘录），返回与查询最相关的条目。"
            "回答涉及历史项目、已保存资料、专业知识点时，先调用本工具再作答。"
            "query 留空时返回知识库最近条目（用于'知识库里有什么'这类泛查询）。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索关键词或问题（留空=列最近条目）"},
                "top_k": {"type": "integer", "description": "返回条数（默认 5）"},
            },
            "required": [],
        },
    },
    "memory_search": {
        "name": "memory_search",
        "description": (
            "检索长期记忆（偏好/决策/教训/进度等自动沉淀的记忆），返回相关记忆条目。"
            "用户提到'之前/上次/你记得吗'等回忆型问题时使用，帮助记住用户偏好与历史进度。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索关键词或问题"},
                "top_k": {"type": "integer", "description": "返回条数（默认 5）"},
            },
            "required": ["query"],
        },
    },
    "memory_add": {
        "name": "memory_add",
        "description": (
            "写入一条长期记忆（用户明确告知的偏好/决策等，视为高可信）。"
            "用户明确表达个人偏好或约束时使用——包括肯定式（'我喜欢/习惯/以后都…'）和否定式"
            "（'我不喜欢/讨厌/好难闻/不要用…'），如'我不喜欢鱼腥草'就应写入 preference。"
            "持续性的口味/习惯/约束都写；一次性情绪（如'今天心情不好'）不写。"
            "content 只写核心事实本身（≤30 字，如'用户喜欢小狗'），"
            "禁止'用户表达/提到…这体现了/在后续对话中'等填充与推导。"
            "写入前会自动查重，重复则更新已有记忆。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "要记住的核心事实（≤30 字，只写事实本身）"},
                "memory_type": {"type": "string", "description": "类型：preference（默认）/decision/pitfall/fact/pattern"},
            },
            "required": ["content"],
        },
    },
    "memory_delete": {
        "name": "memory_delete",
        "description": "按 id 删除一条长期记忆（先用 memory_search 找到目标 id）。用户明确要求删除某条记忆时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "memory_id": {"type": "string", "description": "要删除的记忆 id（来自 memory_search 结果）"},
            },
            "required": ["memory_id"],
        },
    },
    "memory_update": {
        "name": "memory_update",
        "description": "按 id 修改一条长期记忆的内容（先用 memory_search 找到目标 id）。用户要求纠正/更新某条记忆时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "memory_id": {"type": "string", "description": "要修改的记忆 id"},
                "content": {"type": "string", "description": "新的记忆内容"},
            },
            "required": ["memory_id", "content"],
        },
    },
    "knowledge_delete": {
        "name": "knowledge_delete",
        "description": "按 id 删除一条知识库条目（先用 knowledge_query 找到目标 id）。用户明确要求删除某条知识时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "entry_id": {"type": "string", "description": "要删除的知识条目 id（来自 knowledge_query 结果）"},
            },
            "required": ["entry_id"],
        },
    },
    "knowledge_update": {
        "name": "knowledge_update",
        "description": "按 id 修改一条知识库条目的标题或内容（先用 knowledge_query 找到目标 id）。用户要求纠正/更新某条知识时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "entry_id": {"type": "string", "description": "要修改的知识条目 id"},
                "content": {"type": "string", "description": "新的内容（可选）"},
                "title": {"type": "string", "description": "新的标题（可选）"},
            },
            "required": ["entry_id"],
        },
    },
    "read_file": {
        "name": "read_file",
        "description": "读取项目内某个文本文件的内容（只读）。默认返回整个文件（无需反复分段重读）；超大文件（>8 万字符）才用 offset/limit 分段读取。",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "文件路径（相对项目根目录）"},
                "offset": {"type": "integer", "description": "起始行号（从 0 开始，可选）"},
                "limit": {"type": "integer", "description": "读取行数（默认返回整个文件）"},
            },
            "required": ["path"],
        },
    },
    "write_file": {
        "name": "write_file",
        "description": "写入/覆盖项目内的一个文本文件（会创建不存在的父目录）。用户要求创建或修改文件时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "文件路径（相对项目根目录）"},
                "content": {"type": "string", "description": "要写入的完整内容"},
            },
            "required": ["path", "content"],
        },
    },
    "list_dir": {
        "name": "list_dir",
        "description": "列出项目内某个目录下的文件和子目录（只读）。需要了解目录结构时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "目录路径（相对项目根目录，空=根目录）"},
            },
            "required": [],
        },
    },
    "search_file": {
        "name": "search_file",
        "description": "按文件名模式搜索项目内的文件（如 *.py、test*.ts），支持通配符（只读）。",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "文件名匹配模式（如 *.py）"},
                "path": {"type": "string", "description": "限定目录（可选，空=全项目）"},
            },
            "required": ["pattern"],
        },
    },
    "fs_delete": {
        "name": "fs_delete",
        "description": "删除项目内的文件或目录（危险，需用户授权）。用户明确要求删除时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "要删除的文件/目录路径"},
            },
            "required": ["path"],
        },
    },
    "move_rename": {
        "name": "move_rename",
        "description": "移动或重命名项目内的文件/目录。用户要求移动/重命名时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "source": {"type": "string", "description": "源路径"},
                "destination": {"type": "string", "description": "目标路径"},
            },
            "required": ["source", "destination"],
        },
    },
    "file_grep": {
        "name": "file_grep",
        "description": "在项目文件内容中搜索关键字（只读，返回匹配的文件:行号:内容）。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "要搜索的关键字/文本"},
                "path": {"type": "string", "description": "限定目录（可选，空=全项目）"},
                "max_results": {"type": "integer", "description": "最大结果数（默认 100）"},
            },
            "required": ["query"],
        },
    },
    "http_get": {
        "name": "http_get",
        "description": "发起 HTTP GET 请求，抓取网页/接口内容（只读，返回状态码 + 正文截断）。",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "完整 URL（含 https://）"},
                "timeout": {"type": "integer", "description": "超时秒数（默认 15）"},
            },
            "required": ["url"],
        },
    },
    "http_post": {
        "name": "http_post",
        "description": "发起 HTTP POST 请求（调用接口/提交数据）。用户要求调用某个 HTTP 接口时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "完整 URL（含 https://）"},
                "body": {"type": "string", "description": "请求体（JSON 字符串，可选）"},
                "content_type": {"type": "string", "description": "Content-Type（默认 application/json）"},
                "timeout": {"type": "integer", "description": "超时秒数（默认 15）"},
            },
            "required": ["url"],
        },
    },
    "download_file": {
        "name": "download_file",
        "description": (
            "从 URL 下载文件并保存到项目内指定路径（如软件包、数据文件、资源文件）。"
            "用户要求下载文件到本地时使用；保存路径限项目目录内。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "下载地址（完整 URL，含 https://）"},
                "save_path": {"type": "string", "description": "保存路径（相对项目根目录，如 downloads/xxx.zip）"},
            },
            "required": ["url", "save_path"],
        },
    },
    "web_search": {
        "name": "web_search",
        "description": "联网搜索，返回相关网页的标题/链接/摘要（只读）。需要查最新信息、外部资料时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词"},
                "max_results": {"type": "integer", "description": "返回条数（默认 5，最多 10）"},
            },
            "required": ["query"],
        },
    },
    "web_fetch": {
        "name": "web_fetch",
        "description": "抓取某个网页的正文内容（只读，返回提取后的纯文本）。需要读某篇文章/文档内容时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "完整 URL（含 https://）"},
                "max_chars": {"type": "integer", "description": "最大返回字符数（默认 4000）"},
            },
            "required": ["url"],
        },
    },
    "run_tests": {
        "name": "run_tests",
        "description": "在项目里运行测试（pytest），返回测试结果。用户要求验证代码/跑测试时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "测试文件/目录（可选，空=全量）"},
                "timeout": {"type": "integer", "description": "超时秒数（默认 300）"},
            },
            "required": [],
        },
    },
    "lint": {
        "name": "lint",
        "description": "对项目代码做静态检查（ruff/flake8），返回检查结果。用户要求检查代码规范时使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "检查的文件/目录（可选，空=全项目）"},
                "timeout": {"type": "integer", "description": "超时秒数（默认 120）"},
            },
            "required": [],
        },
    },
    "task_plan": {
        "name": "task_plan",
        "description": (
            "制定/创建任务执行计划：把复杂目标拆成若干步骤，创建计划并跟踪进度。"
            "用户提出需要多步完成的目标时，先调用本工具列计划，再逐步执行并用 todo_update 更新进度。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "goal": {"type": "string", "description": "目标描述（要完成的事）"},
                "steps": {
                    "type": "string",
                    "description": "步骤列表，每行一个步骤（用换行分隔，如：步骤1\\n步骤2\\n步骤3）",
                },
            },
            "required": ["goal"],
        },
    },
    "todo_update": {
        "name": "todo_update",
        "description": (
            "更新任务计划进度。执行多步任务时，每完成一步就用 step_index 标记该步完成，"
            "让用户的计划本实时显示进度。先用 task_plan 创建计划拿到 task_id。"
            "全部步骤做完后再用 status=completed 标记整体完成。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "任务 id（来自 task_plan 返回）"},
                "status": {"type": "string", "description": "任务整体状态：in_progress / completed（可选，通常最后才用）"},
                "step_index": {"type": "integer", "description": "标记第几步完成（从 1 开始，每完成一步就调用一次，可选）"},
                "note": {"type": "string", "description": "进度备注（可选）"},
            },
            "required": ["task_id"],
        },
    },
    "open_app": {
        "name": "open_app",
        "description": (
            "打开本地应用或文件（如记事本、计算器、某个文档/文件夹）。"
            "用户要求打开某个程序或文件时使用。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "target": {"type": "string", "description": "要打开的应用名（如 notepad、calc）或文件/文件夹路径"},
            },
            "required": ["target"],
        },
    },
    "browser_open": {
        "name": "browser_open",
        "description": (
            "打开浏览器并访问指定网址。用户要求浏览网页、查页面内容时先用本工具打开，"
            "之后可用 browser_click 点击元素、browser_read_dom 读取页面内容。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "要访问的完整网址（含 https://）"},
            },
            "required": ["url"],
        },
    },
    "browser_click": {
        "name": "browser_click",
        "description": (
            "点击浏览器当前页面中的元素（CSS 选择器，如 #submit、.btn-login）。"
            "需要先用 browser_open 打开页面，或用截图确认元素后点击。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "selector": {"type": "string", "description": "目标元素的 CSS 选择器"},
            },
            "required": ["selector"],
        },
    },
    "browser_read_dom": {
        "name": "browser_read_dom",
        "description": (
            "读取浏览器当前页面的内容（标题 + 正文纯文本，只读）。"
            "打开网页后需要了解页面内容时使用。"
        ),
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    "screenshot": {
        "name": "screenshot",
        "description": (
            "截取当前屏幕，返回图片（dataURL）。"
            "用户提到看屏幕/当前画面/截屏时使用，可与 web_search 等配合。"
        ),
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "clipboard_read": {
        "name": "clipboard_read",
        "description": "读取剪贴板中的文本内容（只读）。",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "clipboard_write": {
        "name": "clipboard_write",
        "description": "把一段文本写入剪贴板。",
        "parameters": {
            "type": "object",
            "properties": {"content": {"type": "string", "description": "要写入的文本"}},
            "required": ["content"],
        },
    },
    "notify": {
        "name": "notify",
        "description": "发送一条 Windows 系统通知（右下角气泡）。",
        "parameters": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "通知标题（默认 Nis）"},
                "message": {"type": "string", "description": "通知内容"},
            },
            "required": [],
        },
    },
    "window_control": {
        "name": "window_control",
        "description": "窗口控制：minimize_all（最小化所有窗口）/ restore（恢复窗口）。",
        "parameters": {
            "type": "object",
            "properties": {"action": {"type": "string", "description": "minimize_all / restore"}},
            "required": ["action"],
        },
    },
}

# 纯文本工具（执行不触发权限卡，直接跑）
NON_INTERACTIVE_TOOLS: set[str] = {
    "code_search", "git_status", "git_diff", "git_log", "skill_execute",
    "knowledge_query", "memory_search",
    "read_file", "list_dir", "search_file", "file_grep", "http_get",
    "web_search", "web_fetch",
    "task_plan", "todo_update", "browser_read_dom",
    "screenshot", "clipboard_read",
    "plugin_list", "skill_list",
}
# 未知/未注册工具统一风险：high（gate_keeper 兜底）
UNKNOWN_TOOL_RISK = "high"

# 核心工具固定顺序（缓存前缀稳定性：注册顺序变化不会打乱 tools 字节序）
_CORE_TOOL_ORDER: list[str] = [
    "read_file", "write_file", "list_dir", "search_file", "file_grep",
    "diff_edit", "shell_exec",
    "http_get", "http_post", "download_file", "web_search", "web_fetch",
    "run_tests", "lint",
    "git_status", "git_diff", "git_log", "git_commit", "git_auto_commit",
    "memory_search", "knowledge_query",
    "task_plan", "todo_update", "open_app", "browser_open", "browser_click", "browser_read_dom",
    "fs_delete", "move_rename", "skill_execute", "task", "screenshot", "clipboard_read",
]


def build_chat_tools(registered: list[str]) -> list[dict[str, Any]]:
    """根据已注册 gateway 工具构建 LLM tools 列表（始终含 clarify / request_partners）。

    request_partners 不是 gateway 工具（不触发权限卡），但流程模式下 AI 需要它来召集伙伴。
    顺序确定性（步骤10，缓存命中）：核心工具固定顺序 → 其余按名字典序 → 同会话内字节不变。
    """
    tools: list[dict[str, Any]] = [CLARIFY_TOOL, {"type": "function", "function": GATEWAY_TOOL_SCHEMAS["request_partners"]}]
    by_name: dict[str, dict[str, Any]] = {}
    for name in registered:
        schema = GATEWAY_TOOL_SCHEMAS.get(name)
        if schema:
            by_name[name] = {"type": "function", "function": schema}
    for name in _CORE_TOOL_ORDER:
        if name in by_name:
            tools.append(by_name.pop(name))
    for name in sorted(by_name):
        tools.append(by_name[name])
    return tools


def tool_args(tool_name: str, args: dict) -> Optional[dict]:
    """LLM 传入参数 → gateway 工具实际 kwargs。

    参数损坏（_raw 包装：解析失败/流式截断）→ 返回 None，调用方**不得执行**该工具
    （此前返回 {} 导致工具以空参数裸奔执行——审计 T2 问题）。
    """
    if "_raw" in args:
        return None
    return dict(args)
