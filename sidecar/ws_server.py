"""WebSocket bridge between the Python pipeline and the Tauri front-end.

Architecture:
  Tauri shell (webview) <--ws:// localhost:7433--> this server <-> pipeline threads

Messages are newline-delimited JSON.  Server → client events:
  {"type": "transcript",  "speaker": 0, "text": "...", "is_final": true}
  {"type": "answer_token","token": "..."}
  {"type": "answer_end"}
  {"type": "status",      "state": "listening"|"answering"|"reconnecting"}
  {"type": "mode",        "mode": "technical_interview"}
  {"type": "history",     "pos": 2, "total": 3, "question": "...", "answer": "..."}
  {"type": "session_end", "summary": "...", "debrief": "..."}
  {"type": "web",         "enabled": true}

Client → server commands:
  {"cmd": "cycle_mode"}
  {"cmd": "toggle_web"}
  {"cmd": "regenerate"}
  {"cmd": "clear"}
  {"cmd": "nav", "delta": -1}
  {"cmd": "quit"}
  {"cmd": "end_session"}
  {"cmd": "quick_debrief", "text": "..."}
"""
import asyncio
import json
import re
import sys
import threading
import queue
import os
import time

import websockets

# ── path: allow importing the existing pipeline ──────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "heario-poc"))  # pipeline lives here; folder rename tracked separately

import assistant
from answer_history import AnswerHistory
from session_log import SessionLog
from config import SPEAKER_NAMES as _SPEAKER_NAMES

PORT = 7433
_hist = AnswerHistory()
_log  = SessionLog()

import atexit
atexit.register(lambda: _log.export(speaker_names=_SPEAKER_NAMES))

# Thread-safe event queue: pipeline threads push events; the asyncio loop broadcasts them.
_events: "queue.Queue[dict]" = queue.Queue()
_connected: set = set()
_pipeline_started = False
_paused = False
_web_enabled = False
# Wall-clock time of the last real transcript. The free-plan STT meter charges
# only windows that actually contained speech, so leaving the app open in
# silence doesn't burn the 20-min quota.
_last_transcript_ts = 0.0

from config import USER_SPEAKER as _USER_SPEAKER_CFG
_user_speaker: "int | None" = (
    int(_USER_SPEAKER_CFG) if _USER_SPEAKER_CFG not in ("none", "None", "", "auto") else None
)
_user_last_spoke: float = 0.0
_USER_PAUSE_SECS: float = 2.5


# ── pipeline callbacks ────────────────────────────────────────────────────────

def on_transcript(speaker, text):
    global _user_last_spoke, _last_transcript_ts
    if _paused:
        return
    _last_transcript_ts = time.time()   # marks this window as "active" for STT metering
    from assistant import looks_like_question
    is_q = looks_like_question(text)

    # Auto-pause: track when the user themselves speaks
    is_user = (_user_speaker is not None and speaker == _user_speaker)
    if is_user:
        _user_last_spoke = time.time()
    suppress = is_user or (
        _user_speaker is not None and
        (time.time() - _user_last_spoke) < _USER_PAUSE_SECS
    )

    answered = is_q and not suppress
    _events.put({"type": "transcript", "speaker": speaker, "text": text,
                 "is_question": is_q, "answered": answered})
    _hist.set_pending(f"S{speaker} Q: {text}" if speaker is not None else f"Q: {text}")
    _log.utterance(speaker, text, is_q, answered)
    if answered:
        _events.put({"type": "status", "state": "answering"})
        if _web_enabled:
            _events.put({"type": "status", "state": "searching"})
        _hist.begin()
        parts = []
        sink = _make_conf_sink(parts, _hist)
        assistant.stream_answer(text, sink, use_web=_web_enabled)
        _log.set_answer("".join(parts))
        _events.put({"type": "answer_end"})
        _events.put({"type": "status", "state": "listening"})
        _push_history()


def _make_conf_sink(parts, hist_obj=None):
    """Return a sink function that strips [C:N] confidence prefix and emits a confidence event."""
    conf_buf  = []
    conf_done = [False]

    def sink(tok):
        if not conf_done[0]:
            conf_buf.append(tok)
            combined = "".join(conf_buf)
            if "]" in combined:
                m = re.search(r'\[C:\s*(\d)\s*\]', combined)
                if m:
                    _events.put({"type": "confidence", "score": int(m.group(1))})
                remainder = re.sub(r'\[C:\s*\d\s*\]\s*\n?', '', combined)
                if remainder.strip():
                    parts.append(remainder)
                    if hist_obj: hist_obj.append(remainder)
                    _events.put({"type": "answer_token", "token": remainder})
                conf_done[0] = True
            elif len(combined) > 25:          # gave up waiting for tag
                conf_done[0] = True
                parts.append(combined)
                if hist_obj: hist_obj.append(combined)
                _events.put({"type": "answer_token", "token": combined})
        else:
            parts.append(tok)
            if hist_obj: hist_obj.append(tok)
            _events.put({"type": "answer_token", "token": tok})

    return sink


def _push_history():
    q, a, pos, total = _hist.current()
    _events.put({"type": "history", "pos": pos, "total": total,
                 "question": q, "answer": a})


def _push_mode():
    _events.put({"type": "mode", "mode": assistant.current_mode()})


# ── command handlers ──────────────────────────────────────────────────────────

def handle_cmd(msg: dict):
    global _paused, _web_enabled
    cmd = msg.get("cmd")
    if cmd == "pause":
        _paused = True
        _events.put({"type": "status", "state": "paused"})
    elif cmd == "resume":
        _paused = False
        _events.put({"type": "status", "state": "listening"})
    elif cmd == "toggle_web":
        _web_enabled = not _web_enabled
        _events.put({"type": "web", "enabled": _web_enabled})
    elif cmd == "research_company":
        company_name = msg.get("name", "").strip()
        if not company_name:
            from config import COMPANY_NAME
            company_name = COMPANY_NAME
        if not company_name:
            return
        def run():
            _events.put({"type": "status", "state": "searching"})
            try:
                from search import research_company as do_search
                from config import BASE_DIR
                raw = do_search(company_name)
                parts = []
                brief = assistant.stream_research_brief(
                    raw, company_name, lambda t: parts.append(t))
                brief = brief or "".join(parts)
                # persist next to the sidecar so Tauri can read it via get_settings
                brief_path = os.path.join(BASE_DIR, "company_brief.txt")
                with open(brief_path, "w", encoding="utf-8") as f:
                    f.write(brief)
                assistant.set_company_brief(brief)
                _events.put({"type": "research_done", "brief": brief})
            except Exception as e:
                _events.put({"type": "research_done", "brief": "", "error": str(e)})
            _events.put({"type": "status", "state": "listening"})
        threading.Thread(target=run, daemon=True).start()
    elif cmd == "set_length":
        assistant.set_length(msg.get("length", "normal"))
        _events.put({"type": "length", "length": assistant.current_length()})
    elif cmd == "cycle_mode":
        assistant.cycle_mode(); _push_mode()
    elif cmd == "regenerate":
        def run():
            _events.put({"type": "status", "state": "answering"})
            parts = []
            sink = _make_conf_sink(parts)
            assistant.regenerate(sink)
            _log.regenerated("".join(parts))
            _events.put({"type": "answer_end"})
            _events.put({"type": "status", "state": "listening"})
            _push_history()
        threading.Thread(target=run, daemon=True).start()
    elif cmd == "ask":
        question = msg.get("question", "").strip()
        if not question:
            return
        def run():
            _events.put({"type": "status", "state": "searching" if _web_enabled else "answering"})
            _hist.set_pending(f"[manual] {question}")
            _hist.begin()
            parts = []
            sink = _make_conf_sink(parts, _hist)
            assistant.stream_answer(question, sink, use_web=_web_enabled)
            _log.set_answer("".join(parts))
            _events.put({"type": "answer_end"})
            _events.put({"type": "status", "state": "listening"})
            _push_history()
        threading.Thread(target=run, daemon=True).start()
    elif cmd == "clear":
        _events.put({"type": "answer_token", "token": ""}); _events.put({"type": "answer_end"})
    elif cmd == "nav":
        _hist.nav(msg.get("delta", 0)); _push_history()
    elif cmd == "quit":
        _events.put({"type": "session_end", "summary": assistant.session_summary()})
        _log.export(speaker_names=_SPEAKER_NAMES)
    elif cmd == "end_session":
        def run():
            global _log
            _events.put({"type": "status", "state": "answering"})
            debrief = assistant.generate_debrief(_log._events)
            summary = assistant.session_summary()
            _log.export(speaker_names=_SPEAKER_NAMES)
            _events.put({"type": "session_end", "summary": summary, "debrief": debrief})
            _log = SessionLog()
            assistant.reset_session()
            _events.put({"type": "status", "state": "listening"})
        threading.Thread(target=run, daemon=True).start()
    elif cmd == "quick_debrief":
        text = msg.get("text", "")
        def run():
            _events.put({"type": "status", "state": "answering"})
            debrief = assistant.generate_quick_debrief(text)
            _events.put({"type": "quick_debrief_result", "debrief": debrief})
            _events.put({"type": "status", "state": "listening"})
        threading.Thread(target=run, daemon=True).start()


# ── websocket handler ─────────────────────────────────────────────────────────

_STT_LIMIT_MSG = ("🔒 Free speech-to-text limit (20 min) reached. "
                  "Upgrade at heario.ai/#pricing to keep transcribing.")


def _emit_stt_limit():
    """Tell the UI the free STT cap is hit — a transcript banner plus a status."""
    _events.put({"type": "transcript", "speaker": None, "text": _STT_LIMIT_MSG,
                 "is_question": False, "answered": False})
    _events.put({"type": "status", "state": "stt_limit"})


def _start_stt_meter(stop_evt: threading.Event, tick_seconds: int = 30):
    """Charge *active* transcription time against the free-plan STT quota.

    Ticks every `tick_seconds`, but only spends quota for windows that actually
    contained speech (a transcript arrived since the previous tick) — so leaving
    the app open in silence doesn't burn the 20-min cap. When the cap is crossed
    it sets stop_evt (which halts whichever STT backend is active) and notifies
    the UI. Runs only for free users — caller gates on stt_quota.is_metered().
    `tick_seconds` is injectable so tests can drive it without real-time waits."""
    import stt_quota

    def run():
        window_start = time.time()
        while not stop_evt.is_set():
            if stop_evt.wait(tick_seconds):
                break  # process exiting
            had_speech = _last_transcript_ts > window_start
            window_start = time.time()
            if not had_speech:
                continue  # silent window — don't spend quota
            remaining = stt_quota.add_usage(tick_seconds)
            if remaining is not None and remaining <= 0:
                stop_evt.set()      # stop all STT backends
                _emit_stt_limit()
                break

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def _start_pipeline():
    """Start the Deepgram STT + answer pipeline in a background thread (once only)."""
    global _pipeline_started
    if _pipeline_started:
        return
    _pipeline_started = True

    from config import STT_BACKEND, DEEPGRAM_API_KEY, OPENAI_API_KEY
    # Set when STT must stop: process exit OR the free-plan STT cap being hit.
    stop_evt = threading.Event()

    # Free-plan speech-to-text cap (20 min). Metered here, at the one dispatch
    # point shared by all three STT backends, so switching to local Whisper can't
    # bypass it. Paid (license-key) users are unmetered and skip this entirely.
    import stt_quota
    if stt_quota.is_metered():
        if (stt_quota.remaining_seconds() or 0) <= 0:
            _emit_stt_limit()
            return  # already exhausted — don't start transcription at all
        _start_stt_meter(stop_evt)

    use_deepgram   = bool(DEEPGRAM_API_KEY) and STT_BACKEND in ("deepgram", "auto")
    use_openai_stt = not use_deepgram and bool(OPENAI_API_KEY) and STT_BACKEND in ("openai", "auto")

    if use_deepgram:
        from stream_stt import stream_transcripts
        def run():
            print("[pipeline] starting Deepgram stream...")
            try:
                stream_transcripts(on_transcript, stop_evt)
            except RuntimeError as e:
                msg = str(e)
                print(f"[pipeline] audio error: {msg}")
                _events.put({"type": "status", "state": "error"})
                _events.put({"type": "transcript", "speaker": None,
                             "text": f"⚠ Audio error: {msg}. Go to Settings → Audio Source.",
                             "is_question": False, "answered": False})
        threading.Thread(target=run, daemon=True).start()
    elif use_openai_stt:
        # OpenAI Whisper API — reuses existing OpenAI key, no extra signup
        from openai_whisper_stt import stream_transcripts as openai_whisper_transcripts
        def run():
            print("[pipeline] starting OpenAI Whisper API stream...")
            try:
                openai_whisper_transcripts(on_transcript, stop_evt)
            except Exception as e:
                msg = str(e)
                print(f"[pipeline] OpenAI Whisper error: {msg}")
                _events.put({"type": "status", "state": "error"})
                _events.put({"type": "transcript", "speaker": None,
                             "text": f"⚠ OpenAI Whisper error: {msg}",
                             "is_question": False, "answered": False})
        threading.Thread(target=run, daemon=True).start()
    else:
        # No Deepgram or OpenAI key — fall back to local Whisper (no signup required)
        from config import WHISPER_MODEL
        from local_whisper_stt import stream_transcripts as whisper_transcripts
        def run():
            print(f"[pipeline] starting local Whisper ({WHISPER_MODEL})...")
            _events.put({"type": "transcript", "speaker": None,
                         "text": f"⏳ Loading local Whisper model ({WHISPER_MODEL}) — first run downloads ~150 MB, please wait…",
                         "is_question": False, "answered": False})
            try:
                whisper_transcripts(on_transcript, stop_evt)
            except Exception as e:
                msg = str(e)
                is_audio = isinstance(e, RuntimeError)
                print(f"[pipeline] Whisper error: {msg}")
                _events.put({"type": "status", "state": "error"})
                if is_audio:
                    _events.put({"type": "transcript", "speaker": None,
                                 "text": f"⚠ Audio error: {msg}. Go to Settings → Audio Source.",
                                 "is_question": False, "answered": False})
                else:
                    _events.put({"type": "transcript", "speaker": None,
                                 "text": "⚠ Could not load Whisper model. Check your internet connection for first-run download, or add a Deepgram key in Settings.",
                                 "is_question": False, "answered": False})
                return
        threading.Thread(target=run, daemon=True).start()


async def handler(ws):
    global _pipeline_started
    _connected.add(ws)
    # Send current state to newly-connected client
    await ws.send(json.dumps({"type": "mode",   "mode":    assistant.current_mode()}))
    await ws.send(json.dumps({"type": "length", "length":  assistant.current_length()}))
    await ws.send(json.dumps({"type": "status", "state":   "paused" if _paused else "listening"}))
    # Start the audio pipeline on first connection
    if not _pipeline_started:
        _start_pipeline()
    try:
        async for raw in ws:
            try:
                handle_cmd(json.loads(raw))
            except Exception as e:
                print(f"[ws] bad command: {e}")
    except websockets.ConnectionClosed:
        pass
    finally:
        _connected.discard(ws)


async def _broadcaster():
    """Drain the event queue and broadcast each event to all connected clients."""
    loop = asyncio.get_event_loop()
    while True:
        try:
            ev = await loop.run_in_executor(None, lambda: _events.get(timeout=0.05))
            msg = json.dumps(ev)
            if _connected:
                await asyncio.gather(*[c.send(msg) for c in list(_connected)],
                                     return_exceptions=True)
        except queue.Empty:
            await asyncio.sleep(0.01)


async def main():
    print(f"[ws] sidecar listening on ws://localhost:{PORT}")
    async with websockets.serve(handler, "localhost", PORT):
        await _broadcaster()          # runs forever


def _free_port(port: int):
    """Kill any process already bound to our port so we can restart cleanly."""
    import socket, subprocess
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("localhost", port)) != 0:
            return  # port is free
    try:
        subprocess.run(
            ["powershell", "-Command",
             f"Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue "
             f"| Select-Object -ExpandProperty OwningProcess "
             f"| ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}"],
            capture_output=True, timeout=5
        )
    except Exception:
        pass

if __name__ == "__main__":
    _free_port(PORT)
    asyncio.run(main())
