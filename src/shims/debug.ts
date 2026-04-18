type DebugFunction = ((...args: unknown[]) => void) & {
    namespace: string;
    enabled: boolean;
    extend: (suffix: string) => DebugFunction;
};

type DebugFactory = ((namespace: string) => DebugFunction) & {
    coerce: (value: unknown) => unknown;
    disable: () => string;
    enable: (_namespaces: string) => void;
    enabled: (_namespace: string) => boolean;
    humanize: (value: number) => string;
    formatters: Record<string, (value: unknown) => unknown>;
};

const createDebug = ((namespace: string) => {
    const debugFn = ((..._args: unknown[]) => {
        // Intentionally a no-op for worker-compatible builds.
    }) as DebugFunction;

    debugFn.namespace = namespace;
    debugFn.enabled = false;
    debugFn.extend = (suffix: string) => createDebug(`${namespace}:${suffix}`);

    return debugFn;
}) as DebugFactory;

createDebug.coerce = (value: unknown) => value;
createDebug.disable = () => "";
createDebug.enable = (_namespaces: string) => {
    // no-op
};
createDebug.enabled = (_namespace: string) => false;
createDebug.humanize = (value: number) => String(value);
createDebug.formatters = {};

export default createDebug;
