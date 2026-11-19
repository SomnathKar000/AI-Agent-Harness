# @harness/policy

Security policy engine governing tool invocations, command execution, path access, and network permissions.

Hard rule: Policy is default-deny, enforced in code. The agent never touches shell or filesystem directly.
