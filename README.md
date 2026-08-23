# BH Droid FS20 Multiplayer Server — V18 WSS

Servidor exclusivo do Farming Simulator 20 Mobile.

A V18 mantém o bridge HTTP que já existia (`/bridge`) e adiciona o transporte real da partida pelo mesmo serviço do Render usando WebSocket em `/relay`.

## O que continua funcionando

- registro e retomada de sala;
- lista de salas online/offline;
- detalhes da sala;
- heartbeat;
- atualização de jogadores;
- marcar sala offline;
- remoção definitiva por `remove`;
- `mapId` textual (`MapUS`, `MapDE`, etc.).

## Transporte V18

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
