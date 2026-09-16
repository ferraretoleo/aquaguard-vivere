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
- Evolução de pH, cloro e alcalinidade
- Histórico completo e detalhes de cada manutenção
- Início e fechamento do serviço em momentos diferentes
- Fotos no início e no fim do serviço
- Cadastro de locais e piscinas
- Relatório PDF e texto pronto para WhatsApp
- Envio do relatório de evolução química por e-mail
- Layout responsivo para celular
- Importação automática dos 50 registros coletados do AquaGuard atual
- Página avulsa de usuários em `/usuarios`, visível somente para administradores

## Publicação rápida

1. Crie um banco gratuito no Neon e copie a `DATABASE_URL`.
2. Coloque esta pasta em um repositório GitHub.
3. No Render, clique em **New +**, **Blueprint** e escolha o repositório.
4. Preencha as variáveis pedidas pelo arquivo `render.yaml`.
5. Informe uma senha forte em `ADMIN_PASSWORD`.
6. Após a publicação, acesse a URL do Render e entre com `ADMIN_EMAIL` e `ADMIN_PASSWORD`.

O sistema cria as tabelas, o local Vivere Palhano, as piscinas Adulto e Infantil e o histórico existente na primeira inicialização.

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

Para Gmail, ative a verificação em duas etapas e crie uma senha de aplicativo. Preencha:

- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=465`
- `SMTP_SECURE=true`
- `SMTP_USER`
- `SMTP_PASSWORD`
- `SMTP_FROM`

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

Nela é possível cadastrar, editar, redefinir senha, definir o nível de acesso, selecionar o local e ativar ou desativar usuários.

Cada usuário comum enxerga somente o local ao qual está vinculado, incluindo as piscinas e manutenções desse local. Usuários com perfil `ADMIN` podem visualizar e administrar todos os locais, usuários, piscinas e manutenções.

O login Google somente aceita e-mails previamente cadastrados pelo administrador nessa página. Isso impede a criação automática de usuários sem local definido.

## Segurança

- Senhas protegidas com bcrypt
- Sessão em cookie HTTP-only
- Perfis ADMIN e USER
- Cadastros restritos a administradores
- Queries parametrizadas
- Limite de tamanho e tipo para fotos
