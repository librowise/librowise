"""Asyncio TCP server for SIP2.

One coroutine per connection reads CR (or LF) terminated messages and hands each one to the
synchronous :class:`~librowise.sip2.handlers.Sip2Handler` in a worker thread (the database
layer is synchronous). Connections are closed after an idle timeout (shorter before login),
after repeated malformed messages or failed logins, and when a message exceeds the size limit.
Optional TLS is supported for deployments that cannot use a VPN or stunnel.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import ssl
from dataclasses import dataclass

from .handlers import HandlerConfig, Sip2Handler

log = logging.getLogger("librowise.sip2")

_EOL = re.compile(rb"[\r\n]")


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 6001
    delimiter: str = "|"
    encoding: str = "utf-8"
    login_timeout: float = 60.0  # seconds a connection may stay open without logging in
    max_message_bytes: int = 16 * 1024
    max_connections: int = 256
    response_timeout_tenths: int = 100
    certfile: str | None = None
    keyfile: str | None = None


class MessageTooLong(Exception):
    pass


class _LineReader:
    """Reads messages terminated by CR, LF or CR LF from a stream."""

    def __init__(self, reader: asyncio.StreamReader, limit: int) -> None:
        self.reader = reader
        self.limit = limit
        self.buf = bytearray()

    async def next(self) -> bytes | None:
        while True:
            m = _EOL.search(self.buf)
            if m:
                msg = bytes(self.buf[: m.start()])
                del self.buf[: m.end()]
                if msg.strip(b"\x00 "):
                    return msg
                continue
            if len(self.buf) > self.limit:
                raise MessageTooLong
            chunk = await self.reader.read(4096)
            if not chunk:
                if self.buf.strip(b"\x00 \r\n"):  # final message without terminator
                    msg = bytes(self.buf)
                    self.buf.clear()
                    return msg
                return None
            self.buf += chunk


class Sip2Server:
    def __init__(self, config: ServerConfig | None = None, handler: Sip2Handler | None = None) -> None:
        self.config = config or ServerConfig()
        self.handler = handler or Sip2Handler(HandlerConfig(
            delimiter=self.config.delimiter, encoding=self.config.encoding,
            response_timeout_tenths=self.config.response_timeout_tenths,
            login_timeout=self.config.login_timeout))
        self._server: asyncio.base_events.Server | None = None
        self._connections: set[asyncio.Task] = set()

    @property
    def port(self) -> int:
        assert self._server is not None
        return self._server.sockets[0].getsockname()[1]

    def _ssl_context(self) -> ssl.SSLContext | None:
        if not self.config.certfile:
            return None
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(self.config.certfile, self.config.keyfile)
        return ctx

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._client, self.config.host, self.config.port,
                                                  ssl=self._ssl_context(), limit=self.config.max_message_bytes * 2)
        log.info("sip2 event=listening host=%s port=%s tls=%s", self.config.host, self.port,
                 bool(self.config.certfile))
        return self.port

    async def serve_forever(self) -> None:
        if self._server is None:
            await self.start()
        assert self._server is not None
        async with self._server:
            await self._server.serve_forever()

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await self._server.wait_closed()
        for task in list(self._connections):
            task.cancel()
        if self._connections:
            await asyncio.gather(*self._connections, return_exceptions=True)

    async def _client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        peername = writer.get_extra_info("peername") or ("?", 0)
        peer = f"{peername[0]}:{peername[1]}"
        if len(self._connections) >= self.config.max_connections:
            log.warning("sip2 event=connection_refused peer=%s reason=too_many_connections", peer)
            writer.close()
            return
        if task is not None:
            self._connections.add(task)
        session = self.handler.new_session(peer)
        lines = _LineReader(reader, self.config.max_message_bytes)
        log.info("sip2 event=connect peer=%s", peer)
        reason = "closed"
        try:
            while True:
                timeout = session.idle_timeout if session.authenticated else self.config.login_timeout
                try:
                    raw = await asyncio.wait_for(lines.next(), timeout)
                except TimeoutError:
                    reason = "idle_timeout"
                    break
                except MessageTooLong:
                    reason = "message_too_long"
                    break
                if raw is None:
                    reason = "eof"
                    break
                response, close = await asyncio.to_thread(self.handler.handle, session, raw)
                if response:
                    writer.write(response)
                    await writer.drain()
                if close:
                    reason = "protocol_close"
                    break
        except asyncio.CancelledError:
            reason = "server_shutdown"
        except (ConnectionError, OSError) as exc:
            reason = f"connection_error:{type(exc).__name__}"
        finally:
            log.info("sip2 event=disconnect peer=%s account=%s reason=%s messages=%d", peer,
                     session.login or "-", reason, session.messages)
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
            if task is not None:
                self._connections.discard(task)


def run(config: ServerConfig) -> None:
    """Blocking entry point used by ``python -m librowise sip2``."""
    from ..db import create_all

    create_all()
    server = Sip2Server(config)

    async def main() -> None:
        await server.start()
        try:
            await server.serve_forever()
        finally:
            await server.stop()

    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
