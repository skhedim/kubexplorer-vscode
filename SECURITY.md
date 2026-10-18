# Security Policy

## Supported versions

Security fixes are made on the latest released version.

## Reporting a vulnerability

Please do not open a public issue. Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/skhedim/kubexplorer-vscode/security/advisories/new).

Include the version of KubeXplorer and VS Code, the steps to reproduce, and the impact you observed. You will get an
answer within a week; once a fix is released, the advisory is published with credit to the reporter, unless you
prefer to stay anonymous.

## Scope

KubeXplorer runs `kubectl` and `helm` with your credentials. Of particular interest:

- a workspace or a cluster object that can make KubeXplorer run commands or binaries it should not;
- Secret values reaching the UI, logs or storage without an explicit reveal;
- an action reaching another context than the one shown in its confirmation.
