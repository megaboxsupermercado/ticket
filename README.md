# Senhas do Açougue · Megabox Supermercado

Sistema de senhas para o açougue: o cliente retira a senha no **totem**, a **TV** chama com som e voz, o atendente controla a fila na **tela do operador** e o dono acompanha tempo de espera e clientes atendidos nos **relatórios**.

| Tela | Endereço | Quem usa |
| --- | --- | --- |
| Totem | `/totem?chave=CHAVE_LOJA` (dentro do app Android) | Cliente |
| Painel | `/painel?chave=CHAVE_LOJA` | TV do açougue |
| Operador | `/operador` | Atendentes (nome + `SENHA_OPERADOR`) |
| Relatórios | `/relatorios` | Dono (`SENHA_DONO`) |

## Regras da fila

- Duas filas: Normal (N001, N002...) e Preferencial (P001, P002...). A numeração volta para 001 todo dia (horário de Brasília).
- **Chamar próxima** alterna as filas: 2 normais, 1 preferencial (`NORMAIS_POR_PREFERENCIAL`). Se uma fila está vazia, chama a outra.
- **Finalizar atendimento** registra o tempo no balcão. Chamar a próxima sem finalizar encerra a senha anterior automaticamente.
- **Cliente ausente** marca a senha como ausente. Senhas que ficam esperando até o fim do dia viram desistência.
- Todo o histórico fica guardado no banco para os relatórios (espera média e máxima, atendimento médio, movimento por horário e planilha para Excel).

## Rodar no computador (para testar)

Precisa de Node.js 20+ e PostgreSQL.

```bash
cp .env.example .env   # ajuste as senhas
npm install
export $(cat .env | xargs) && npm start
# abra http://localhost:3000
```

Testes automáticos: `npm test` (usa o banco de `DATABASE_URL`).

## Colocar na internet (Render)

1. Crie uma conta em [render.com](https://render.com) e escolha **New > Blueprint**, apontando para este repositório. O arquivo `render.yaml` cria o servidor e o banco.
2. Preencha `SENHA_OPERADOR` e `SENHA_DONO` quando o Render pedir. A `CHAVE_LOJA` é gerada sozinha: copie o valor na aba *Environment* do serviço.
3. O endereço fica parecido com `https://senhas-acougue.onrender.com`.

Qualquer outra hospedagem com Node.js e PostgreSQL também serve: basta definir as variáveis do `.env.example`.

## Totem (Android + Epson TM-T20X por USB)

O app fica em `android/`. A cada envio para o GitHub, a aba **Actions > App do totem** gera o APK (`totem-senhas-apk`).

1. Instale o APK no totem (permita "fontes desconhecidas").
2. Ligue a TM-T20X no USB do totem. Quando o Android perguntar, abra com **Totem Senhas** e marque "usar sempre".
3. Na primeira abertura, informe o endereço do sistema e a chave da loja e toque em **Imprimir teste**.
4. Em *Configurações > Tela inicial*, escolha **Totem Senhas** para o app abrir sozinho ao ligar.
5. Para voltar à configuração depois: toque **7 vezes seguidas no canto superior esquerdo**.

O app imprime direto pelo cabo USB em ESC/POS (sem driver): logo, "AÇOUGUE", a senha em letra grande, data, hora e corte do papel.

## Painel (TV Android)

1. Instale um navegador de quiosque, como o **Fully Kiosk Browser**.
2. Endereço inicial: `https://SEU-ENDERECO/painel?chave=CHAVE_LOJA`.
3. Ative: iniciar com o aparelho, manter a tela ligada e permitir reprodução automática de som.
4. Se aparecer "Toque na tela para ativar o som", toque uma vez (o navegador exige isso quando a reprodução automática está desligada).
5. A voz usa o leitor de texto do Android: confira se a voz em português está instalada em *Configurações > Idioma > Saída de texto para fala*.

## Variáveis de ambiente

Veja `.env.example`.
