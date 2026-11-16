# Connection

## Responsibilities

Receives incoming Socket.IO connections. The `CheckConnection` application query rejects every
connection until handshake authentication exists. The gateway applies that decision by disconnecting
the socket. The shared Redis adapter in application bootstrap checks the Origin before a connection
reaches the gateway.

## Public entry points

None. The application root imports `connection.module` to register the gateway and its use case.
