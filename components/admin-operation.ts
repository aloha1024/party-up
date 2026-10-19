// Owned by AdminPanel; extracted children share its pending and error boundary.
export type AdminOperation = {
  pending: boolean;
  run: (task: () => Promise<void>) => void;
  checkOnline: () => boolean;
  refreshAfterSuccess: () => void;
};

export type AdminFormOperation = AdminOperation & {
  hydrated: boolean;
  setError: (message: string) => void;
};
