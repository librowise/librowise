"""A minimal synchronous SIP2 client — used by the test-suite and handy for diagnosing a
deployment (``python -c "from librowise.sip2.client import SipClient; ..."``)."""

from __future__ import annotations

import socket

from . import protocol as p


class SipClient:
    def __init__(self, host: str, port: int, *, delimiter: str = p.DEFAULT_DELIMITER,
                 encoding: str = p.DEFAULT_ENCODING, error_detection: bool = False, timeout: float = 10.0) -> None:
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.delimiter = delimiter
        self.encoding = encoding
        self.error_detection = error_detection
        self.seq = 0
        self._buf = b""

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass

    def __enter__(self) -> SipClient:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def send_raw(self, data: bytes) -> bytes:
        """Send raw bytes and return the next CR-terminated response (without the CR)."""
        self.sock.sendall(data)
        return self.read_raw()

    def read_raw(self) -> bytes:
        while b"\r" not in self._buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("Connection closed by server")
            self._buf += chunk
        line, _, self._buf = self._buf.partition(b"\r")
        return line

    def request(self, code: str, fixed: list[str], fields: list[tuple[str, object]] = ()) -> p.Message:
        seq = None
        if self.error_detection:
            seq = str(self.seq)
            self.seq = (self.seq + 1) % 10
        raw = p.format_message(code, fixed, fields, delimiter=self.delimiter, encoding=self.encoding,
                               sequence=seq, error_detection=self.error_detection)
        return p.parse(self.send_raw(raw), delimiter=self.delimiter, encoding=self.encoding)

    # convenience wrappers --------------------------------------------------------------

    def login(self, user: str, password: str, location: str = "") -> bool:
        r = self.request("93", ["0", "0"], [("CN", user), ("CO", password), ("CP", location or None)])
        return r.fixed["ok"] == "1"

    def now(self) -> str:
        from datetime import UTC, datetime

        return p.sip_datetime(datetime.now(UTC))

    def sc_status(self) -> p.Message:
        return self.request("99", ["0", "080", p.PROTOCOL_VERSION])
