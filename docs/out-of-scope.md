# Orchestrator — Out of Scope

## Flows and complex dependencies
Job A → Job B is supported. DAGs, fan-out, branching, conditional execution → use a flow engine.

## Authentication
Dashboard is local-only. No login, no multi-user.

## Remote access
127.0.0.1 binding only. No tunneling built-in.

## Container/VM isolation
Jobs run as plain child processes. No Docker, no sandboxing.

## Built-in scripting language
Jobs call external commands. No inline scripts in the config.
