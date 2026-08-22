# BH Droid FS20 Multiplayer Server — REAL V1

Projeto **exclusivo do Farming Simulator 20 Mobile**.

Esta versão foi desenhada depois da análise do `dataS` e do APK FS20 fornecidos para o projeto. Ela não reaproveita o servidor do FS23 e não tenta adivinhar o protocolo binário oficial.

## O que esta V1 faz

Ela implementa o diretório/lobby do nosso servidor:

- registra uma sala do host;
- gera ID e token próprios;
- lista salas;
- entrega detalhes de conexão;
- recebe heartbeat;
- atualiza quantidade de jogadores;
- remove salas quando o host encerra;
- expira hosts que param de enviar heartbeat.

Os nomes dos campos foram alinhados com os callbacks existentes em `MasterServerConnection.lua`, principalmente `onServerInfo(...)` e `onServerInfoDetails(...)`.

## O que ainda NÃO faz

O APK original não conversa diretamente com esta API ainda.

O master server original do FS20 usa ENet/UDP e uma camada de handshake/autenticação criptográfica própria. Em vez de fingir que já reproduzimos isso, a próxima etapa será ligar o FS20 a esta API por um patch específico do cliente.

A sessão de jogo usa a porta padrão `10823`. Para dois celulares em redes diferentes, ainda precisaremos tornar o host alcançável pela Internet ou implementar um relay próprio. O lobby HTTP sozinho não resolve CGNAT/NAT.

## API

Base: `/api/fs20/v1`

- `GET /health`
- `GET /api/fs20/v1/info`
- `GET /api/fs20/v1/rooms`
- `POST /api/fs20/v1/rooms/register`
- `GET /api/fs20/v1/rooms/:id`
- `POST /api/fs20/v1/rooms/:id/heartbeat`
- `DELETE /api/fs20/v1/rooms/:id`

## Teste rápido

Depois de hospedar, abra `/health`. A resposta deve conter `"ok":true`.

Não coloque o ZIP inteiro dentro do repositório. Extraia o pacote e envie os arquivos da raiz.
