# Central Pequenos Sonhos 3D

Painel do Mercado Livre com conexão da Shopee Open Platform e consulta de pedidos dos últimos sete dias. A conexão da Shopee requer uma aplicação aprovada na [Shopee Open Platform](https://open.shopee.com/); o painel não cria anúncios na Shopee nesta etapa.

## Configuração da Shopee

Na Vercel, adicione as variáveis de ambiente de produção:

- `SHOPEE_PARTNER_ID`: Partner ID **Live** da sua aplicação.
- `SHOPEE_PARTNER_KEY`: Partner Key **Live**. Mantenha em segredo.
- `SHOPEE_REDIRECT_URI`: `https://central-pequenos-sonhos-3d.vercel.app/api/shopee/callback`.

Configure o mesmo domínio de redirecionamento no console da Shopee. O banco de dados (`DATABASE_URL`), a chave de proteção (`APP_DATA_KEY`) e a sessão de administrador (`APP_SESSION_KEY`) já usados pela Central continuam necessários. Depois do deploy, entre no painel e toque em **Conectar minha loja Shopee**. O processo salva os tokens criptografados no banco, verifica a conexão e permite consultar os 50 primeiros pedidos atualizados nos últimos sete dias. A tarefa diária da Vercel renova o token quando necessário.

Nunca coloque Partner Key, tokens ou senhas no repositório ou no chat. Para testes de uma aplicação ainda não aprovada, use as credenciais e o ambiente de teste indicados pela Shopee; esta versão está configurada para o ambiente Live.

## Verificação

`npm run check` valida a sintaxe e testa a assinatura das chamadas à Shopee.
