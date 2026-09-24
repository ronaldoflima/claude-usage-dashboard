"""Codex adapters. Persist counters only; never credentials or conversation text."""
from __future__ import annotations

import json
import math
import os
import selectors
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from app import QuotaClient, UsageIndex, parse_timestamp, safe_int

DEFAULT_CODEX_DIR = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))


def normalize_limits(raw):
    """Accept both the documented RPC format and rollout snake_case snapshots."""
    if not isinstance(raw, dict):
        raise ValueError("Invalid Codex limits response.")
    buckets = raw.get("rateLimitsByLimitId")
    if not isinstance(buckets, dict) or not buckets:
        bucket = raw.get("rateLimits", raw)
        if not isinstance(bucket, dict):
            return {"limits": [], "source": "codex_app_server"}
        buckets = {bucket.get("limitId", bucket.get("limit_id", "codex")): bucket}
    limits = []
    for bucket_id, bucket in buckets.items():
        if not isinstance(bucket, dict):
            continue
        for window in ("primary", "secondary"):
            item = bucket.get(window)
            if not isinstance(item, dict):
                continue
            pct = item.get("usedPercent", item.get("used_percent"))
            minutes = item.get("windowDurationMins", item.get("window_minutes"))
            reset = item.get("resetsAt", item.get("resets_at"))
            try:
                pct, minutes, reset = float(pct), int(minutes), float(reset)
                if not math.isfinite(pct) or not 0 <= pct <= 100 or minutes <= 0:
                    continue
                resets_at = datetime.fromtimestamp(reset, timezone.utc).isoformat()
            except (TypeError, ValueError, OverflowError, OSError):
                continue
            limits.append({
                "key": f"{bucket_id}:{window}", "bucket": str(bucket_id),
                "kind": "weekly_all" if minutes == 10080 else "session",
                "label": str(bucket.get("limitName") or bucket.get("limit_name") or bucket_id),
                "window_minutes": minutes, "utilization": pct, "resets_at": resets_at,
            })
    return {"limits": limits, "source": "codex_app_server"}


class CodexQuotaClient(QuotaClient):
    def __init__(self, codex_dir: Path, binary: str = "codex"):
        super().__init__(codex_dir)
        self.codex_dir, self.binary = codex_dir, binary

    _normalize = staticmethod(normalize_limits)

    def _fetch(self):
        """Only initialize + read account limits. Never start a thread or turn."""
        env = {**os.environ, "CODEX_HOME": str(self.codex_dir)}
        try:
            with subprocess.Popen([self.binary, "app-server"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  env=env) as process:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    buffer = b""
                    deadline = time.monotonic() + 12

                    def send(message):
                        process.stdin.write(json.dumps(message).encode() + b"\n")
                        process.stdin.flush()

                    try:
                        send({"id": 1, "method": "initialize", "params": {
                            "clientInfo": {"name": "local_usage_dashboard", "version": "1.0"}}})
                        while time.monotonic() < deadline:
                            if not selector.select(max(0, deadline - time.monotonic())):
                                break
                            chunk = os.read(process.stdout.fileno(), 65536)
                            if not chunk:
                                break
                            buffer += chunk
                            if len(buffer) > 2_000_000:
                                raise ValueError("Codex response exceeded the size limit.")
                            while b"\n" in buffer:
                                line, buffer = buffer.split(b"\n", 1)
                                try:
                                    message = json.loads(line)
                                except ValueError:
                                    continue
                                if message.get("id") not in (1, 2):
                                    continue
                                if "error" in message:
                                    # Never echo remote errors that might include account data.
                                    raise ValueError("Codex account read failed. Check CLI login and version.")
                                if message["id"] == 1:
                                    send({"method": "initialized", "params": {}})
                                    send({"id": 2, "method": "account/rateLimits/read", "params": {}})
                                elif isinstance(message.get("result"), dict):
                                    return message["result"]
                        raise ValueError("Codex account read timed out or the process exited.")
                    finally:
                        if process.poll() is None:
                            process.terminate()
                            try:
                                process.wait(timeout=2)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait()
        except OSError:
            raise ValueError("Codex CLI unavailable. Install it or configure --codex-bin.") from None


class CodexIndex(UsageIndex):
    """Reparse changed rollouts to preserve cumulative baselines across appends.

    Unchanged files are skipped. Forked history before session creation is ignored;
    cumulative counters establish a baseline but never count as new activity.
    """
    def __init__(self, codex_dir: Path, db_path: Path):
        super().__init__(codex_dir, db_path)
        self.codex_dir = codex_dir
        self.connection.execute("""CREATE TABLE IF NOT EXISTS limit_observations (
            source_path TEXT PRIMARY KEY, observed_at TEXT NOT NULL, payload TEXT NOT NULL)""")
        self.connection.commit()

    def refresh(self):
        started = time.monotonic()
        files = events = 0
        with self.lock, self.connection:
            for folder in ("sessions", "archived_sessions"):
                for path in (self.codex_dir / folder).rglob("*.jsonl"):
                    try:
                        stat = path.stat()
                        relative = str(path.relative_to(self.codex_dir))
                        previous = self.connection.execute(
                            "SELECT size, mtime_ns FROM source_files WHERE path=?", (relative,)).fetchone()
                        if previous and tuple(previous) == (stat.st_size, stat.st_mtime_ns):
                            continue
                        with path.open("rb") as handle:
                            records, observation = self._parse(handle, relative)
                        self.connection.execute("DELETE FROM usage_events WHERE source_path=?", (relative,))
                        for record in records:
                            self._upsert_event(record)
                        self.connection.execute("DELETE FROM limit_observations WHERE source_path=?", (relative,))
                        if observation:
                            self.connection.execute("INSERT INTO limit_observations VALUES (?, ?, ?)",
                                (relative, observation["fetched_at"], json.dumps(observation)))
                        self.connection.execute("INSERT OR REPLACE INTO source_files VALUES (?, ?, ?, ?)",
                                                (relative, stat.st_size, stat.st_size, stat.st_mtime_ns))
                        files += 1
                        events += len(records)
                    except OSError:
                        continue
        return {"files": files, "events": events, "elapsed_ms": round((time.monotonic() - started) * 1000)}

    @staticmethod
    def _parse(handle, relative):
        session = relative
        model, cwd = "unknown", ""
        created = None
        previous = None
        records = []
        observation = None
        keys = ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens")
        for number, raw in enumerate(handle):
            if not raw.endswith(b"\n"):
                break
            try:
                row = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                continue
            if not isinstance(row, dict) or not isinstance(row.get("payload"), dict):
                continue
            payload = row["payload"]
            if row.get("type") == "session_meta":
                session = str(payload.get("id") or payload.get("session_id") or relative)
                cwd = str(payload.get("cwd") or "")
                created = parse_timestamp(payload.get("timestamp"))
                continue
            if row.get("type") == "turn_context":
                model = str(payload.get("model") or "unknown")
                cwd = str(payload.get("cwd") or cwd)
                continue
            if row.get("type") != "event_msg" or payload.get("type") != "token_count":
                continue
            timestamp = parse_timestamp(row.get("timestamp"))
            if timestamp is None:
                continue
            inherited = created is not None and timestamp < created
            rate_limits = payload.get("rate_limits")
            if not inherited and isinstance(rate_limits, dict):
                normalized = normalize_limits(rate_limits)
                if normalized["limits"]:
                    observation = {"ok": True, **normalized, "source": "codex_local_snapshot",
                                   "fetched_at": datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat()}
            info = payload.get("info")
            if not isinstance(info, dict) or not isinstance(info.get("total_token_usage"), dict):
                continue
            current = {key: safe_int(info["total_token_usage"].get(key)) for key in keys}
            if inherited:
                previous = current
                continue
            if previous == current:
                continue  # repeated notifications are not additional responses
            if previous is None or any(current[k] < previous[k] for k in keys):
                # First observation and counter resets: last request, not lifetime usage.
                last = info.get("last_token_usage")
                delta = {key: safe_int(last.get(key)) for key in keys} if isinstance(last, dict) else None
            else:
                delta = {key: current[key] - previous[key] for key in keys}
            previous = current
            if not delta or not (delta["input_tokens"] + delta["output_tokens"]):
                continue
            cached = min(delta["cached_input_tokens"], delta["input_tokens"])
            records.append({
                "event_key": f"{session}:{timestamp}:{number}", "source_path": relative,
                "timestamp_ms": timestamp, "session_id": session, "model": model,
                "cwd": cwd, "project": Path(cwd).name if cwd else "unknown",
                "input_tokens": delta["input_tokens"] - cached,
                "cache_read_tokens": cached, "cache_creation_tokens": 0,
                "output_tokens": delta["output_tokens"],
                "thinking_tokens": min(delta["reasoning_output_tokens"], delta["output_tokens"]),
            })
        return records, observation

    def local_limits(self):
        with self.lock:
            row = self.connection.execute(
                "SELECT payload FROM limit_observations ORDER BY observed_at DESC LIMIT 1").fetchone()
        return json.loads(row[0]) if row else {"ok": False, "limits": [], "error": "No local Codex limit snapshot."}


class SnapshotStore:
    """Keep official samples separate from inferred activity and local snapshots."""
    def __init__(self, path):
        import sqlite3
        import threading
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("""CREATE TABLE IF NOT EXISTS quota_snapshots (
            provider TEXT, key TEXT, observed_ms INTEGER, resets_at TEXT,
            utilization REAL, window_minutes INTEGER,
            PRIMARY KEY (provider, key, observed_ms))""")
        self.db.commit()

    def record(self, provider, payload):
        observed = parse_timestamp(payload.get("fetched_at"))
        if not payload.get("ok") or payload.get("stale") or observed is None:
            return
        if payload.get("source") not in ("anthropic_oauth", "codex_app_server"):
            return
        with self.lock, self.db:
            for limit in payload.get("limits", []):
                self.db.execute("INSERT OR IGNORE INTO quota_snapshots VALUES (?, ?, ?, ?, ?, ?)",
                    (provider, limit["key"], observed, limit.get("resets_at"), limit["utilization"],
                     limit.get("window_minutes", 300 if limit["kind"] == "session" else 10080)))

    def read(self, provider):
        cutoff = int((time.time() - 90 * 86400) * 1000)
        with self.lock:
            return [dict(row) for row in self.db.execute(
                "SELECT * FROM quota_snapshots WHERE provider=? AND observed_ms>=? ORDER BY observed_ms",
                (provider, cutoff))]
