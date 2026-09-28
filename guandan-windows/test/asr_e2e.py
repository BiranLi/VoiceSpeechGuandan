#!/usr/bin/env python3
"""
S6 · 真实语音端到端测试（S1.10 / FR-3 / S6.5）。

走完整 HTTP 链路：macOS `say` 合成 → 16kHz 单声道 WAV → POST /api/asr → 断言文本。

用法：
    python3 test/asr_e2e.py [base_url]

无 DASHSCOPE_API_KEY 时**跳过并打印说明**（不判失败，CI 友好）。
需先启动开发服务器：npm run dev（Key 需在该进程的 env 中）

⚠️ 两个已踩过的坑，勿改回：
1. 语音名必须用**全名**（如 "Flo (中文（中国大陆）)"）。传短名 "Flo" 不匹配，
   say 会输出固定杂音（不同文本产生逐位相同的音频）或纯静音，e2e 假失败。
2. 断言用"子串包含"，不能用 == ——ASR 常带句号，且可能输出等价表面形式
   （实测「三带五」被识别为「3+5」）。

这里用 http.client 而非 urllib.request：目标地址经 scheme 校验后才拆成
host/port，无法退化成 file: 等自定义 scheme（与代理的 assertHttps 同一条红线）。
"""
import base64
import http.client
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:6677").rstrip("/")

# 全名语音；已实测本机 18 个 zh 语音均可用
VOICES = ["Flo (中文（中国大陆）)", "Meijia"]

# (原文, 可接受的等价表面形式)
CASES = [
    ("过", ["过"]),
    ("顺子", ["顺子"]),
    ("三带五", ["三带五", "3带5", "3+5"]),   # 字母/数字等价形式
    ("大王", ["大王"]),
    ("炸弹", ["炸弹"]),
    ("对K", ["对K", "对开"]),             # 字母 K 易被听成中文词，见输出说明
]

# 已知会因同音误识的用例：不计入硬失败，但必须显式标出
SOFT_CASES = {"对K", "炸弹", "大王"}


def connection(base: str, timeout: int) -> http.client.HTTPConnection:
    """校验 scheme 后建立连接；只允许 http/https"""
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme not in ("http", "https"):
        raise SystemExit(f"仅允许 http/https 地址，收到: {base!r}")
    if not parsed.hostname:
        raise SystemExit(f"地址缺少主机名: {base!r}")
    cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    return cls(parsed.hostname, parsed.port, timeout=timeout)


def post_asr(base: str, audio_b64: str, timeout: int = 60) -> tuple:
    """POST /api/asr，返回 (耗时秒, 响应 JSON)"""
    parsed = urllib.parse.urlparse(base)
    payload = json.dumps({"audio_base64": audio_b64, "mime": "audio/wav"}).encode()
    conn = connection(base, timeout)
    t0 = time.time()
    try:
        conn.request(
            "POST", f"{parsed.path or ''}/api/asr",
            body=payload,
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        return time.time() - t0, json.loads(resp.read().decode())
    finally:
        conn.close()


def is_reachable(base: str) -> bool:
    try:
        conn = connection(base, 5)
        try:
            conn.request("GET", urllib.parse.urlparse(base).path or "/")
            conn.getresponse().read()
            return True
        finally:
            conn.close()
    except Exception:
        return False


def make_wav(text: str, voice: str) -> bytes:
    """用 macOS say 合成 16kHz 单声道 Int16 WAV，返回其字节"""
    with tempfile.TemporaryDirectory() as d:
        aiff = os.path.join(d, "a.aiff")
        wav = os.path.join(d, "a.wav")
        subprocess.run(["say", "-v", voice, "-o", aiff, text], check=True)
        subprocess.run(
            ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", aiff, wav], check=True)
        with open(wav, "rb") as f:
            return f.read()


def main() -> int:
    if not os.environ.get("DASHSCOPE_API_KEY"):
        print("⏭  跳过：未设置 DASHSCOPE_API_KEY（CI 无 Key 时正常跳过）")
        return 0

    if not is_reachable(BASE):
        print(f"⏭  跳过：{BASE} 不可达。请先 npm run dev")
        return 0

    print(f"=== S1.10 真实语音 e2e @ {BASE}/api/asr ===")
    print(f"{'原文':<8} {'耗时':<6} 结果")
    hard_fail = 0
    for text, accepted in CASES:
        b64 = base64.b64encode(make_wav(text, VOICES[0])).decode()
        el, r = post_asr(BASE, b64)
        if "error" in r:
            print(f"{text:<8} {el:<6.2f} ❌ {r['error'][:70]}")
            hard_fail += 1
            continue
        got = r.get("text", "")
        if any(a in got for a in accepted):
            print(f"{text:<8} {el:<6.2f} ✅ {got!r}")
        elif text in SOFT_CASES:
            print(f"{text:<8} {el:<6.2f} ⚠️  误识 {got!r}")
        else:
            print(f"{text:<8} {el:<6.2f} ❌ {got!r}")
            hard_fail += 1

    print("\n注：'对K' 一类字母误识是 ASR 同音问题（K 被听成「开/运费」），非管线故障。")
    print("    对策见 requirements.md FR-4：云端热词，或改用「老K」等口语说法。")
    print(f"\n硬失败 {hard_fail} 项")
    return 1 if hard_fail else 0


if __name__ == "__main__":
    sys.exit(main())
