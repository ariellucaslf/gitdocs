import { app } from './app.js';
import { env } from './config/env.js';

const PORT = env.PORT;

app.listen(PORT, () => {
  console.log(`🚀 GitDocs Backend running on port ${PORT}`);
  console.log(`📡 Healthcheck available at http://localhost:${PORT}/health`);
});
