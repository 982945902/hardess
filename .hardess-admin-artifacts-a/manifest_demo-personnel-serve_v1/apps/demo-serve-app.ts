const demoServeApp = {
  kind: "serve",
  middleware: [
    {
      async handler(
        _request: Request,
        env: { pipeline: { id: string; groupId?: string } },
        ctx: { path: string; originalPath: string },
        next: () => Promise<Response | undefined>
      ) {
        const response = await next();
        if (!(response instanceof Response)) {
          return response;
        }

        const headers = new Headers(response.headers);
        headers.set("x-hardess-admin-demo", "true");
        headers.set("x-hardess-admin-scope", "serve");
        headers.set("x-hardess-pipeline-id", env.pipeline.id);
        headers.set("x-hardess-group-id", env.pipeline.groupId ?? "default");
        headers.set("x-hardess-serve-path", ctx.path);
        headers.set("x-hardess-serve-original-path", ctx.originalPath);

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/health",
      handler(
        _request: Request,
        env: { pipeline: { id: string; groupId?: string } },
        ctx: { path: string; originalPath: string }
      ) {
        return Response.json({
          ok: true,
          scope: "serve",
          pipelineId: env.pipeline.id,
          groupId: env.pipeline.groupId ?? null,
          path: ctx.path,
          originalPath: ctx.originalPath
        });
      }
    }
  ]
};

export default demoServeApp;
