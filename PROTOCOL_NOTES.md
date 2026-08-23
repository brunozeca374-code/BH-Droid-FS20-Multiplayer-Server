# FS20 — notas verificadas do protocolo

Estas notas são do **FS20 analisado neste projeto**.

## Master server nativo

O `libgame.so` contém dois front servers:

- `fs19-a.farming-simulator.com`
- `fs19-b.farming-simulator.com`

Portas verificadas:

- `10850`: master server ENet/UDP
- `10851`: HTTPS, usado pelo fluxo de chave pública (`/public_key`)
- `10823`: porta padrão da sessão de jogo

O `MasterServerConnection.lua` chama funções nativas como:

- `masterServerInit`
- `masterServerConnectFront`
- `masterServerConnectBack`
- `masterServerRequestFilteredServers`
- `masterServerRequestServerDetails`
- `masterServerSetServerInfo`
- `masterServerSetNumPlayers`

## IDs de aplicação encontrados no libgame.so

0. CONNECTION_REQUEST
1. CONNECTION_FAILED
2. CONNECTION_READY
3. REQUEST_FILTERED_SERVERS
4. SERVER_INFO
5. REQUEST_SERVER_DETAILS
6. SERVER_INFO_DETAILS
7. SERVER_INFO_DETAILS_FAILED
8. ADD_SERVER
9. SET_SERVER_INFO
10. SET_SERVER_INFO_FAILED
11. SET_NUM_PLAYERS
12. SET_NUM_PLAYERS_FAILED
13. MASTER_SERVER_LIST
14. PORT_TEST
15. NAT_REQUEST_CONNECTION
16. NAT_REQUEST_CONNECTION_FAILED
17. NAT_SET_READY
18. NAT_REQUEST_PORT
19. WAIT_AUTHENTICATING
20. SERVER_ID
21. SET_SERVER_SESSION_NAME
22. SET_SERVER_SESSION_NAME_FAILED

## Enquadramento do pacote

O fluxo de `sendConnectionRequest()` mostra:

1. `TYPE_TIMESTAMP` (25)
2. tempo ENet
3. `APP_MASTERSERVER` (91)
4. packet id `CONNECTION_REQUEST` (0)
5. campos de versão/chave/DLC/idioma

## Decisão de arquitetura

Não vamos copiar cegamente o master server oficial.

O ENet usado pelo jogo possui handshake adicional com acordo de chaves e criptografia autenticada. Portanto, um servidor ENet comum não seria suficiente.

A REAL V1 usa uma API HTTP própria para o diretório de salas. O patch do cliente será responsável por adaptar o fluxo de `MasterServerConnection` para essa API, preservando para a interface do jogo os callbacks que ela já espera.

Isso mantém o projeto FS20 separado e evita declarar compatibilidade que ainda não existe.
