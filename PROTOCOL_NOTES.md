# BH Droid FS20 V19 — protocolo WSS + sincronização de exclusão

## Controle

O lobby existente continua em `GET /bridge?action=...` com as ações:
`ping`, `register`, `list`, `details`, `heartbeat`, `setinfo`, `offline`, `remove`.

O relay fica em `/relay` e usa JSON por WebSocket.

### Host

Envia `host_register` com `roomId`, `roomKey`, `roomName`, `password`, `maxPlayers`, `mapId` e `installId`.

### Convidado

Envia `join` com `roomId`, `password` e `installId`.

O servidor responde `join_ok` com um `streamId` e avisa o host com `guest_joined`.

## Frame binário

- byte 0: versão `1`
- byte 1: opcode DATA `1`
- bytes 2..5: `streamId` uint32 big-endian
- bytes 6..fim: datagrama original do FS20/ENet

O servidor apenas encaminha os bytes; não interpreta o protocolo de gameplay.

## Bridge local Android

Convidado:
`FS20 -> 127.0.0.1:10920 -> libbhfs20.so -> WSS/443 -> Render`

Host:
`Render -> libbhfs20.so -> socket UDP loopback por convidado -> 127.0.0.1:10823 -> FS20 host`

As respostas retornam pelo mesmo caminho. Isso evita depender do IP público/CGNAT do celular host.


## Exclusão de save / sala persistente

A sala continua persistente quando o host apenas sai do jogo (`offline`).
Quando o save A/B/C é realmente excluído, o cliente envia `GET /bridge?action=remove&id=...&token=...`.
O servidor remove o registro persistente e encerra qualquer relay WSS ligado àquela sala.
A operação `remove` é idempotente: se a sala já não existir, o servidor confirma a limpeza.
