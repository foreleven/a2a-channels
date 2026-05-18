"use client";

import {
  ACP_PERMISSION_OPTIONS,
  type AgentConfigFormValidation,
  type AgentConfigFormState,
} from "@/lib/agent-config-form";
import {
  Field as ShadcnField,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export function AgentConfigFields({
  form,
  onChange,
  validation = {},
}: {
  form: AgentConfigFormState;
  onChange(form: AgentConfigFormState): void;
  validation?: AgentConfigFormValidation;
}) {
  const nameError = form.name.trim() ? validation.name : undefined;
  const urlError = form.url.trim() ? validation.url : undefined;
  const commandError = form.command.trim() ? validation.command : undefined;
  const timeoutError = form.timeoutMs.trim()
    ? validation.timeoutMs
    : undefined;

  return (
    <FieldGroup>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          error={nameError}
          inputId="agent-name"
          label="Name"
          required
        >
          <Input
            aria-describedby={nameError ? "agent-name-error" : undefined}
            aria-invalid={Boolean(nameError)}
            id="agent-name"
            onChange={(event) =>
              onChange({ ...form, name: event.target.value })
            }
            placeholder="echo-agent"
            required
            value={form.name}
          />
        </FormField>
        {form.protocol === "a2a" ? (
          <FormField
            error={urlError}
            inputId="agent-url"
            label="A2A URL"
            required
          >
            <Input
              aria-describedby={urlError ? "agent-url-error" : undefined}
              aria-invalid={Boolean(urlError)}
              id="agent-url"
              onChange={(event) =>
                onChange({ ...form, url: event.target.value })
              }
              placeholder="http://localhost:3001"
              required
              value={form.url}
            />
          </FormField>
        ) : form.protocol === "acp" ? (
          <FormField
            error={commandError}
            inputId="agent-command"
            label="Command"
            required
          >
            <Input
              aria-describedby={
                commandError ? "agent-command-error" : undefined
              }
              aria-invalid={Boolean(commandError)}
              id="agent-command"
              onChange={(event) =>
                onChange({ ...form, command: event.target.value })
              }
              placeholder="npx"
              required
              value={form.command}
            />
          </FormField>
        ) : null}
      </div>

      {form.protocol === "a2a" && (
        <FormField label="Context ID Strategy">
          <Select
            onValueChange={(value) =>
              onChange({
                ...form,
                contextIdStrategy:
                  value === "server-assigned"
                    ? "server-assigned"
                    : "client-provided",
              })
            }
            value={form.contextIdStrategy}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="client-provided">Client provided</SelectItem>
                <SelectItem value="server-assigned">Server assigned</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            Server assigned stores the contextId returned by A2A tasks before
            reusing it.
          </FieldDescription>
        </FormField>
      )}

      {form.protocol === "acp" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            className="sm:col-span-2"
            inputId="agent-arguments"
            label="Arguments"
          >
            <Textarea
              className="min-h-24 font-mono text-xs"
              id="agent-arguments"
              onChange={(event) =>
                onChange({ ...form, args: event.target.value })
              }
              placeholder={"@zed-industries/codex-acp\n--some-flag"}
              spellCheck={false}
              value={form.args}
            />
            <FieldDescription>
              One argument per line. The gateway passes these to the stdio
              process without shell parsing. Supports {"{accountId}"} and{" "}
              {"{sessionKey}"} placeholders.
            </FieldDescription>
          </FormField>
          <FormField inputId="agent-cwd" label="Working Directory">
            <Input
              id="agent-cwd"
              onChange={(event) =>
                onChange({ ...form, cwd: event.target.value })
              }
              placeholder="Defaults to gateway cwd"
              value={form.cwd}
            />
            <FieldDescription>
              Supports {"{accountId}"} and {"{sessionKey}"} placeholders.
            </FieldDescription>
          </FormField>
          <FormField label="Permission">
            <Select
              onValueChange={(value) =>
                onChange({
                  ...form,
                  permission:
                    value === "gateway-default"
                      ? ""
                      : parsePermission(value),
                })
              }
              value={form.permission || "gateway-default"}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Gateway default" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="gateway-default">Gateway default</SelectItem>
                  {ACP_PERMISSION_OPTIONS.map((permission) => (
                    <SelectItem key={permission.value} value={permission.value}>
                      {permission.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            error={timeoutError}
            inputId="agent-timeout"
            label="Request Timeout"
          >
            <Input
              aria-describedby={
                timeoutError ? "agent-timeout-error" : undefined
              }
              aria-invalid={Boolean(timeoutError)}
              id="agent-timeout"
              inputMode="numeric"
              onChange={(event) =>
                onChange({ ...form, timeoutMs: event.target.value })
              }
              placeholder="120000"
              value={form.timeoutMs}
            />
          </FormField>
        </div>
      )}

      {form.protocol === "ws-tunnel" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Executor">
            <Select
              onValueChange={(value) => {
                const nextType = value === "codex" ? "codex" : "claude-code";
                const currentDefaultCommand =
                  form.executorType === "codex" ? "npx" : "claude";
                const nextDefaultCommand =
                  nextType === "codex" ? "npx" : "claude";
                const currentDefaultArgs =
                  form.executorType === "codex"
                    ? "@zed-industries/codex-acp"
                    : "--experimental-acp";
                const nextDefaultArgs =
                  nextType === "codex"
                    ? "@zed-industries/codex-acp"
                    : "--experimental-acp";

                onChange({
                  ...form,
                  executorType: nextType,
                  command:
                    !form.command || form.command === currentDefaultCommand
                      ? nextDefaultCommand
                      : form.command,
                  args:
                    !form.args || form.args === currentDefaultArgs
                      ? nextDefaultArgs
                      : form.args,
                });
              }}
              value={form.executorType}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="claude-code">Claude Code</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            error={commandError}
            inputId="executor-command"
            label="Command"
            required
          >
            <Input
              aria-describedby={
                commandError ? "executor-command-error" : undefined
              }
              aria-invalid={Boolean(commandError)}
              id="executor-command"
              onChange={(event) =>
                onChange({ ...form, command: event.target.value })
              }
              placeholder={form.executorType === "codex" ? "npx" : "claude"}
              required
              value={form.command}
            />
          </FormField>
          <FormField
            className="sm:col-span-2"
            inputId="executor-arguments"
            label="Arguments"
          >
            <Textarea
              className="min-h-24 font-mono text-xs"
              id="executor-arguments"
              onChange={(event) =>
                onChange({ ...form, args: event.target.value })
              }
              placeholder={
                form.executorType === "codex"
                  ? "@zed-industries/codex-acp"
                  : "--experimental-acp"
              }
              spellCheck={false}
              value={form.args}
            />
            <FieldDescription>
              One argument per line. The relay CLI starts this as an ACP stdio
              process.
            </FieldDescription>
          </FormField>
          <FormField inputId="executor-cwd" label="Working Directory">
            <Input
              id="executor-cwd"
              onChange={(event) =>
                onChange({ ...form, cwd: event.target.value })
              }
              placeholder="Defaults to relay CLI cwd"
              value={form.cwd}
            />
          </FormField>
          <FormField label="Permission">
            <Select
              onValueChange={(value) =>
                onChange({
                  ...form,
                  permission:
                    value === "gateway-default"
                      ? ""
                      : parsePermission(value),
                })
              }
              value={form.permission || "gateway-default"}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Gateway default" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="gateway-default">Gateway default</SelectItem>
                  {ACP_PERMISSION_OPTIONS.map((permission) => (
                    <SelectItem key={permission.value} value={permission.value}>
                      {permission.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            error={timeoutError}
            inputId="agent-timeout"
            label="Request Timeout (ms)"
          >
            <Input
              aria-describedby={
                timeoutError ? "agent-timeout-error" : undefined
              }
              aria-invalid={Boolean(timeoutError)}
              id="agent-timeout"
              inputMode="numeric"
              onChange={(event) =>
                onChange({ ...form, timeoutMs: event.target.value })
              }
              placeholder="60000"
              value={form.timeoutMs}
            />
            <FieldDescription>
              Milliseconds to wait for the relay CLI to respond.
            </FieldDescription>
          </FormField>
        </div>
      )}

      <FormField inputId="agent-description" label="Description">
        <Textarea
          id="agent-description"
          onChange={(event) =>
            onChange({ ...form, description: event.target.value })
          }
          rows={3}
          value={form.description}
        />
      </FormField>
    </FieldGroup>
  );
}

function FormField({
  className,
  error,
  inputId,
  label,
  required = false,
  children,
}: {
  className?: string;
  error?: string;
  inputId?: string;
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <ShadcnField className={className} data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={inputId}>
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
            <span className="sr-only"> required</span>
          </>
        )}
      </FieldLabel>
      {children}
      {error && inputId && (
        <FieldDescription className="text-destructive" id={`${inputId}-error`}>
          {error}
        </FieldDescription>
      )}
    </ShadcnField>
  );
}

function parsePermission(value: string): AgentConfigFormState["permission"] {
  switch (value) {
    case "allow_once":
    case "allow_always":
    case "reject_once":
    case "reject_always":
      return value;
    default:
      return "";
  }
}
