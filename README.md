# BH Droid FS20 Multiplayer Server — V19 WSS

Servidor exclusivo do Farming Simulator 20 Mobile.

A V19 mantém o bridge HTTP e o relay WSS da V18 e adiciona sincronização entre exclusão do save A/B/C e remoção definitiva da sala persistente.

## O que continua funcionando

- registro e retomada de sala;
- lista de salas online/offline;
- detalhes da sala;
- heartbeat;
- atualização de jogadores;
- marcar sala offline;
- remoção definitiva por `remove`;
- `mapId` textual (`MapUS`, `MapDE`, etc.).

## Transporte V19

- WSS externo: `wss://bh-droid-fs20-multiplayer-server.onrender.com/relay`
- porta pública: 443 (TLS do Render)
- host e convidado fazem conexão de saída para o Render;
- nenhum VPS UDP/Fly.io é necessário;
- o tráfego ENet/UDP do FS20 é encapsulado em frames binários WSS.

## Render

Build command: `npm install`

Start command: `npm start`

Health check: `/health`

O `package.json` inclui `ws`, portanto basta substituir os arquivos da raiz do repositório e aguardar o deploy normal do Render.


## V19 — correção de sala fantasma

`offline` continua preservando a sala. `remove` é usado somente quando o save dono da sala é excluído.
Isso evita que uma sala de um slot A/B/C já apagado continue aparecendo no lobby.
