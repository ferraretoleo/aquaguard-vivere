# AquaGuard Vivere

Reescrita independente do aplicativo de controle de piscinas. A aplicação não utiliza Base44.

## Tecnologia

- Node.js e Express no Render
- PostgreSQL no Neon
- Cloudflare como domínio, proxy e HTTPS
- Login próprio com e-mail e senha
- Login Google opcional
- Relatórios PDF e envio por e-mail
- Fotos armazenadas no Neon para não depender do disco temporário do Render

## Funcionalidades

- Painel com piscinas ativas, manutenções do dia e total de registros
- Evolução de pH, cloro, alcalinidade e estabilizador de cloro (ácido cianúrico/CYA)
- Histórico completo e detalhes de cada manutenção
- Início e fechamento do serviço em momentos diferentes
- Aviso permanente no canto inferior esquerdo enquanto o usuário possui um serviço em andamento
- Fotos no início e no fim do serviço
- Cadastro de locais e piscinas
- Relatório PDF e texto pronto para WhatsApp
- Geração de imagem dos detalhes da manutenção para copiar, compartilhar ou baixar no WhatsApp
- Envio do relatório de evolução química por e-mail
- Layout responsivo para celular
- Página avulsa de usuários em `/usuarios`, visível somente para o administrador geral
- Perfis de administrador geral, administrador local e usuário
- Associação de administradores locais e usuários a um ou mais locais
- Menu de relatórios com filtros por local, piscina e período, respeitando o acesso de cada usuário

## Publicação rápida

1. Crie um banco gratuito no Neon e copie a `DATABASE_URL`.
2. Coloque esta pasta em um repositório GitHub.
3. No Render, clique em **New +**, **Blueprint** e escolha o repositório.
4. Preencha as variáveis pedidas pelo arquivo `render.yaml`.
5. Informe uma senha forte em `ADMIN_PASSWORD`.
6. Após a publicação, acesse a URL do Render e entre com `ADMIN_EMAIL` e `ADMIN_PASSWORD`.

O sistema cria as tabelas, o local Vivere Palhano e as piscinas Adulto e Infantil na primeira inicialização.

Cada usuário vê somente o próprio serviço em andamento e os dados dos locais aos quais tem acesso. A troca de tela ou do filtro de local não apaga nem mistura esse acompanhamento. Enquanto houver um serviço aberto, o sistema impede que o mesmo usuário inicie outro.

## Nova medição: estabilizador de cloro

O fechamento da manutenção exige o valor do estabilizador de cloro (ácido cianúrico/CYA) em ppm. O valor aparece no painel, histórico, detalhes, relatório PDF, relatório por e-mail e texto para WhatsApp.

| Faixa | Classificação | Orientação |
| --- | --- | --- |
| Abaixo de 30 ppm | Ruim (Insuficiente) | Adicionar estabilizador puro ou usar cloro estabilizado. |
| 30 a 50 ppm | Bom (Ideal) | Manter a rotina e medir novamente em 2 a 4 semanas. |
| 51 a 59 ppm | Atenção | Evitar adicionar estabilizador e acompanhar. |
| 60 a 80 ppm | Aceitável (Ideal por Sal) | Manter em piscina de sal; com cloro comum, suspender pastilhas temporariamente. |
| 81 a 100 ppm | Alto (Atenção) | Não adicionar estabilizador e planejar redução por diluição. |
| Acima de 100 ppm | Excesso (Bloqueio) | Drenar parcialmente, em geral 30% a 50%, e completar com água limpa. |

## Limpar as manutenções e preservar cadastros

O arquivo `limpar_manutencoes.sql` apaga definitivamente todas as manutenções e fotos, preservando locais, usuários e piscinas.

Use nesta ordem:

1. Publique esta nova versão no Render e aguarde o status **Live**. Na inicialização, ela adicionará a coluna `stabilizer` ao banco.
2. Se quiser conservar o histórico, faça antes um backup no Neon.
3. No Neon, abra **SQL Editor**, copie o conteúdo de `limpar_manutencoes.sql` e execute.
4. Confira o resultado da consulta final: `manutencoes` deve ser zero e os totais de locais, usuários e piscinas devem permanecer.

A importação automática do histórico antigo foi removida. Assim, o Render não recriará os registros apagados quando reiniciar.

## Cloudflare

Se você já possui um domínio no Cloudflare:

1. No Render, abra **Settings**, **Custom Domains** e adicione o endereço desejado, por exemplo `piscinas.vivere.com.br`.
2. O Render mostrará o destino DNS.
3. No Cloudflare, crie o registro CNAME com o nome escolhido apontando para o endereço informado pelo Render.
4. Deixe a nuvem laranja ativada.
5. Em **SSL/TLS**, utilize **Full**.
6. Atualize `APP_URL` no Render com o endereço final, sem barra no final.

### Endereço gratuito workers.dev

Se você não possui domínio, use o arquivo `cloudflare-worker.js`:

1. No Cloudflare, abra **Workers & Pages** e crie um Worker.
2. Cole o conteúdo de `cloudflare-worker.js` e publique.
3. Em **Settings**, **Variables and Secrets**, crie `RENDER_ORIGIN` com a URL do Render, por exemplo `https://aquaguard-vivere.onrender.com`.
4. No Render, altere `APP_URL` para o endereço final `https://NOME-DO-WORKER.workers.dev`.

O endereço gratuito do Worker passa a abrir a aplicação hospedada no Render.

## Login Google opcional

Crie credenciais OAuth 2.0 no Google Cloud e use como URI de redirecionamento:

`https://SEU-ENDERECO/auth/google/callback`

Depois configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `APP_URL` no Render. Sem essas variáveis, o botão Google fica oculto e o login por e-mail e senha continua funcionando.

## Envio de e-mails

### Render gratuito: Brevo API (recomendado)

O Render gratuito bloqueia conexões SMTP nas portas 25, 465 e 587. Para enviar pela conexão HTTPS liberada no Render, crie uma conta na Brevo, valide o e-mail remetente e gere uma chave de API. No Render, preencha:

- `BREVO_API_KEY`
- `BREVO_SENDER_EMAIL` com o mesmo remetente validado na Brevo
- `BREVO_SENDER_NAME=AquaGuard`

A aplicação usa a Brevo como primeira opção. Os destinatários do Local são enviados em cópia oculta, mantendo um endereço invisível para os demais. A manutenção permanece finalizada mesmo se o provedor de e-mail estiver temporariamente indisponível.

### SMTP alternativo

Em uma hospedagem que permita SMTP, ou em um plano do Render sem esse bloqueio, o Gmail continua disponível como alternativa. Ative a verificação em duas etapas, crie uma senha de aplicativo e preencha:

- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=465`
- `SMTP_SECURE=true`
- `SMTP_USER`
- `SMTP_PASSWORD`
- `SMTP_FROM`

Ao clicar em **Finalizar Serviço**, a manutenção é encerrada e salva imediatamente, sem tentativa de envio de e-mail. O envio de relatório por e-mail continua disponível apenas na área de relatórios, quando solicitado manualmente.

O envio resolve o servidor SMTP exclusivamente por IPv4. Isso evita falhas `ENETUNREACH` em hospedagens que recebem um endereço IPv6 do Gmail, mas não possuem rota IPv6 de saída.

## Desenvolvimento local

```bash
cp .env.example .env
npm install
npm start
```

Acesse `http://localhost:3000`.

## Cadastro de usuários

A página de usuários não aparece no menu principal. Entre como administrador e acesse diretamente:

`https://SEU-ENDERECO/usuarios`

Nela é possível cadastrar, editar, redefinir senha, definir o nível de acesso, selecionar um ou mais locais e ativar ou desativar usuários.

Os perfis funcionam assim:

- `ADMIN`: administrador geral. Vê e administra todos os locais, usuários, piscinas, manutenções e relatórios.
- `LOCAL_ADMIN`: administrador local. Pode administrar locais e piscinas, iniciar e finalizar serviços e consultar relatórios, somente nos locais associados à sua conta. Quando cadastra um novo local, o vínculo com esse local é criado automaticamente.
- `USER`: usuário comum. Pode iniciar e finalizar os próprios serviços e consultar relatórios dos locais associados à sua conta. Não pode alterar locais ou piscinas.

Administradores locais e usuários comuns podem estar associados a vários locais. Esses vínculos ficam na tabela `user_locations`. Na primeira inicialização desta versão, o sistema copia automaticamente para essa tabela os vínculos antigos que estavam em `users.location_id`.

Cada local também pode armazenar vários contatos para futuros alertas e relatórios. Os contatos ficam separados dos e-mails e são compostos por nome e telefone com DDD. Esta versão apenas cadastra e consulta esses dados, sem fazer envio automático por WhatsApp ou SMS.

A migração é automática quando a nova versão inicia no Render. O arquivo `migrar_usuarios_multilocais.sql` também está incluído para aplicação manual pelo SQL Editor do Neon, caso seja necessário preparar o banco antes da publicação.

O login Google somente aceita e-mails previamente cadastrados pelo administrador nessa página. Isso impede a criação automática de usuários sem local definido.

## Segurança

- Senhas protegidas com bcrypt
- Sessão em cookie HTTP-only
- Perfis ADMIN, LOCAL_ADMIN e USER
- Cadastro de usuários restrito ao administrador geral
- Cadastros de locais e piscinas permitidos ao administrador geral e ao administrador local, sempre respeitando os locais associados
- Queries parametrizadas
- Limite de tamanho e tipo para fotos
