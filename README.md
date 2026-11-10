# repo-access-sharer

Microservizio che riceve il webhook `service_created` della Console Mia-Platform e dà accesso al repository del nuovo servizio al team dev, così lo vede senza interventi manuali.

- **GitHub** (default): aggiunge il repository a un team dell'organizzazione (`PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}`).
- **GitLab**: condivide il project con un gruppo (`POST /api/v4/projects/:id/share`).

## Flusso

1. La Console invia `POST /webhooks/service-created` con header `X-Mia-Signature = hex(sha256(body + secret))`.
2. Il servizio verifica la firma (`401` se non valida).
3. Filtra: `eventName == service_created`, `tenantId` in `ALLOWED_TENANT_IDS`, host di `repositoryURL` uguale a quello configurato, owner uguale a `GITHUB_ORG` (GitHub), path sotto `ALLOWED_PATH_PREFIX`. Fuori scope → `200 {"status":"ignored"}`.
4. Chiama il provider:
   - GitHub `204` → `200 {"status":"shared"}` (la chiamata è idempotente)
   - GitLab `201` → `200 {"status":"shared"}`, `409` → `200 {"status":"already_shared"}`
   - `404`, `429`, `5xx`, timeout → retry con backoff esponenziale (il repo può non essere ancora visibile)
   - altri errori (es. `403`, `422`) o retry esauriti → `502 {"status":"failed"}` + log `error`

Il token viene inviato **solo** all'API configurata, mai a un host preso dal payload.

## Endpoint

| Metodo | Path | Descrizione |
|---|---|---|
| `POST` | `/webhooks/service-created` (anche `/service-created`) | target del webhook della Console |
| `GET` | `/-/healthz` | liveness |
| `GET` | `/-/ready` | readiness: `200` solo se il token legge il team/gruppo target (cache 30s) |

## Variabili d'ambiente

### Comuni

| Variabile | Obbligatoria | Default | Note |
|---|---|---|---|
| `REPOSITORY_PROVIDER` | no | `github` (`gitlab` se è valorizzato `GITLAB_BASE_URL`) | `github` o `gitlab` |
| `WEBHOOK_SECRET` | sì | | stesso valore del campo Secret del webhook |
| `ALLOWED_TENANT_IDS` | no | tutti | lista separata da virgole |
| `ALLOWED_PATH_PREFIX` | no | tutti | lista separata da virgole |
| `HTTP_PORT` | no | `3000` | |
| `LOG_LEVEL` | no | `info` | |
| `RETRY_ATTEMPTS` | no | `3` | |
| `RETRY_BASE_DELAY_MS` | no | `1000` | |
| `REQUEST_TIMEOUT_MS` | no | `10000` | |
| `SKIP_SIGNATURE_VERIFICATION` | no | `false` | **solo test locali** |

### GitHub

| Variabile | Obbligatoria | Default | Note |
|---|---|---|---|
| `GITHUB_TOKEN` | sì | | fine-grained PAT, vedi sotto |
| `GITHUB_ORG` | sì | | es. `Mia-Platform-Experiments`; repo di altri owner vengono ignorati |
| `TARGET_TEAM_SLUG` | sì | | slug del team (dall'URL `.../orgs/<org>/teams/<slug>`) |
| `TEAM_PERMISSION` | no | `push` | `pull`, `triage`, `push`, `maintain`, `admin` |
| `GITHUB_API_URL` | no | `https://api.github.com` | GitHub Enterprise Server: `https://<host>/api/v3` |
| `GITHUB_HOST` | no | derivato | host dei `repositoryURL`; serve solo se diverso dall'host dell'API |

Con GitHub `ALLOWED_PATH_PREFIX` può limitare anche il nome repo, es. `Mia-Platform-Experiments/care-` (confronto case-insensitive).

**Token (fine-grained PAT):** Resource owner = l'organizzazione, Repository access = *All repositories*, permessi *Repository → Administration: Read and write* e *Organization → Members: Read-only*. L'utente che lo crea deve essere owner dell'org (o admin dei repo) e vedere il team. Se l'org richiede approvazione dei PAT, va approvato da un owner.

### GitLab

| Variabile | Obbligatoria | Default | Note |
|---|---|---|---|
| `GITLAB_BASE_URL` | sì | | `https://git.tools.mia-platform.eu` |
| `GITLAB_TOKEN` | sì | | token di un service account: Maintainer sui progetti e membro diretto del gruppo target, scope `api` |
| `TARGET_GROUP_ID` | sì | | es. `402038` |
| `GROUP_ACCESS_LEVEL` | no | `30` | `10` Guest, `20` Reporter, `30` Developer, `40` Maintainer |

I vecchi nomi `GITLAB_RETRY_ATTEMPTS`, `GITLAB_RETRY_BASE_DELAY_MS`, `GITLAB_REQUEST_TIMEOUT_MS` sono ancora accettati.

Se manca una variabile obbligatoria il processo termina all'avvio con un log `fatal` che elenca cosa manca.

## Sviluppo

```bash
npm install
npm test
```

## Test manuale contro il servizio deployato

```bash
WEBHOOK_SECRET=<secret> node scripts/send-test-webhook.js \
  https://<host-progetto>/webhooks/service-created \
  https://github.com/<org>/<repo>
```

Verifica su GitHub: repo → **Settings → Collaborators and teams** → deve comparire il team con il permesso configurato.

## Limiti noti

- Copre solo i repository creati con l'evento `service_created`; il repo di configurazione del progetto e i servizi agganciati a repo esistenti vanno gestiti a parte.
- Nessuna revoca automatica dell'accesso.
- I repo creati prima dell'attivazione richiedono un backfill una tantum.
