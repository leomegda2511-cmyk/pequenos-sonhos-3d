# Central Pequenos Sonhos 3D para Vercel

Esta é uma versão preparada para Vercel da central de anúncios do Mercado Livre. Ela inclui painel com senha, conexão OAuth, envio da foto ao Mercado Livre e publicação de enfeite individual ou kit.

## Antes de publicar

1. Crie um projeto na Vercel e conecte um banco Postgres pela Marketplace (por exemplo, Neon). A Vercel injeta a `DATABASE_URL` no projeto quando o banco é conectado.
2. Importe esta pasta para o projeto Vercel e faça o deploy.
3. Cadastre no ambiente de produção as variáveis abaixo. Nunca coloque valores no código nem em conversas.

```
DATABASE_URL
ML_CLIENT_ID
ML_REDIRECT_URI
APP_DATA_KEY
APP_SESSION_KEY
APP_SETUP_CODE
CRON_SECRET
```

- `ML_REDIRECT_URI` deve ser `https://SEU-PROJETO.vercel.app/api/mercadolivre/oauth/callback`.
- Atualize a mesma URI no aplicativo de desenvolvedor do Mercado Livre.
- `APP_DATA_KEY` deve ter 32 bytes em Base64URL.
- `APP_SESSION_KEY`, `APP_SETUP_CODE` e `CRON_SECRET` devem ser valores longos e aleatórios.

## Verificação diária

O `vercel.json` chama `/api/cron/marketplace-sync` diariamente às 08:00 UTC (05:00 em Brasília). A função verifica a conexão, renova o token quando necessário e limpa sessões expiradas. Ela é protegida por `CRON_SECRET`.

## Limite desta primeira versão

O painel publica os anúncios do Mercado Livre quando o proprietário aciona a publicação. Sincronização automática de pedidos/estoque, Shopee, TikTok Shop e respostas automáticas devem ser implementadas nas próximas etapas, pois exigem permissões e APIs próprias.
