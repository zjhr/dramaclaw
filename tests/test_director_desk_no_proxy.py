"""导演台直连模型渠道，不该继承 shell 的代理环境变量。

实测带着 ``HTTP_PROXY`` / ``HTTPS_PROXY``（本机指向 Clash 127.0.0.1:7897）时，
``sharellm.net`` 的请求走那个出口，会被 Cloudflare 拦下：
``403 Forbidden`` + ``Cf-Mitigated: challenge`` + ``text/html``。直连则 3.5 秒
正常返回。症状看着像模型超时或地址填错，真正的原因在中间设备上。

所以本模块每个 httpx 客户端都必须显式 ``trust_env=False``。用 AST 扫一遍，
比逐个人工核对可靠 —— 新增客户端时忘了加，这里就会红。
"""

from __future__ import annotations

import ast
import pathlib

MODULE = pathlib.Path("src/novelvideo/director_desk/ai_host.py")


def _async_clients(tree: ast.AST) -> list[ast.Call]:
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "AsyncClient"
    ]


def test_module_exists() -> None:
    assert MODULE.exists(), f"找不到 {MODULE}"


def test_every_async_client_disables_env_proxy() -> None:
    tree = ast.parse(MODULE.read_text(encoding="utf-8"))
    clients = _async_clients(tree)
    assert clients, "一个 httpx.AsyncClient 都没有，模块被改坏了"
    missing = [
        node.lineno
        for node in clients
        if not any(kw.arg == "trust_env" for kw in node.keywords)
    ]
    assert not missing, f"这些 AsyncClient 没设 trust_env=False：第 {missing} 行"


def test_env_proxy_trust_is_disabled_not_enabled() -> None:
    """必须是 ``trust_env=False``。写成 True 等于没改。"""
    tree = ast.parse(MODULE.read_text(encoding="utf-8"))
    for node in _async_clients(tree):
        for kw in node.keywords:
            if kw.arg == "trust_env":
                assert isinstance(kw.value, ast.Constant) and kw.value.value is False, (
                    f"第 {node.lineno} 行的 trust_env 不是 False"
                )


def test_no_stray_clients_without_the_flag() -> None:
    """用 AST 而非字符串计数 —— 注释里也出现过 ``trust_env=False``，
    按字符串数会得出「3 != 4」这种假失败。"""
    tree = ast.parse(MODULE.read_text(encoding="utf-8"))
    clients = _async_clients(tree)
    flagged = [n for n in clients if any(kw.arg == "trust_env" for kw in n.keywords)]
    assert len(flagged) == len(clients), (
        f"{len(clients)} 个 AsyncClient 里只有 {len(flagged)} 个配了 trust_env"
    )


def test_skill_store_also_disables_env_proxy() -> None:
    """技能包从 GitHub 拉，是本模块第二个会发外网请求的地方。

    ``ai_host`` 那一半由上一条测试守住；这一条守住另一半。漏掉它的后果是
    GitHub 下载走本地代理，症状同样表现为「网络不通」而不是「配置错了」。
    """
    store = pathlib.Path("src/novelvideo/director_desk/skill_store.py")
    assert store.exists(), f"找不到 {store}"
    tree = ast.parse(store.read_text(encoding="utf-8"))
    clients = _async_clients(tree)
    assert clients, "skill_store 里没有 AsyncClient，测试本身该更新了"
    missing = [n.lineno for n in clients if not any(kw.arg == "trust_env" for kw in n.keywords)]
    assert not missing, f"这些 AsyncClient 没设 trust_env=False：第 {missing} 行"