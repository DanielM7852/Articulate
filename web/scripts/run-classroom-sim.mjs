import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});
try {
  const mod = await server.ssrLoadModule('/scripts/classroom-sim.ts');
  await mod.main();
} finally {
  await server.close();
}
