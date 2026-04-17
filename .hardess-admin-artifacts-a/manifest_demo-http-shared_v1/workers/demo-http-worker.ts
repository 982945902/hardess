const demoHttpWorker = {
  async fetch(request: Request, env: { pipeline: { id: string }; auth: { peerId: string } }) {
    const headers = new Headers(request.headers);
    headers.set("x-hardess-worker", env.pipeline.id);
    headers.set("x-hardess-auth-peer", env.auth.peerId);
    headers.set("x-hardess-admin-demo", "true");
    headers.set("x-hardess-admin-scope", "shared");

    return {
      request: new Request(request, {
        headers
      })
    };
  }
};

export default demoHttpWorker;
