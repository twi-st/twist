declare module 'sekai/browser' {
  const createSekai: (options?: { worker?: string }) => {
    megaplay: {
      resolve: (input: { malId: number; episode: number; type: string }) => Promise<unknown>;
    };
  };
  export default createSekai;
}
