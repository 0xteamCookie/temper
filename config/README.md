# Configuration examples

`models.example.json` shows a model fallback chain with per-mode picks. It contains no secrets.

The values map onto VS Code settings:

| Example field      | VS Code setting                  |
| ------------------ | -------------------------------- |
| `chain`            | `temper.models.chain`            |
| `agentMode`        | `temper.models.agentMode`        |
| `inlineEdit`       | `temper.models.inlineEdit`       |
| `fallback.enabled` | `temper.models.fallback.enabled` |
| `fallback.retries` | `temper.models.fallback.retries` |

Model names must match what TrueForge reports at `GET /api/v1/models` (`<provider>/<model alias>`). Providers and their API keys are configured only in TrueForge; put keys in `.env` (git-ignored, see `.env.example`) and never in this folder or in VS Code settings.
