"use client";

import {
  ACP_PERMISSION_OPTIONS,
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
}: {
  form: AgentConfigFormState;
  onChange(form: AgentConfigFormState): void;
}) {
  return (
    <FieldGroup>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Name">
          <Input
            onChange={(event) =>
              onChange({ ...form, name: event.target.value })
            }
            placeholder="echo-agent"
            value={form.name}
          />
        </FormField>
        {form.protocol === "a2a" ? (
          <FormField label="A2A URL">
            <Input
              onChange={(event) =>
                onChange({ ...form, url: event.target.value })
              }
              placeholder="http://localhost:3001"
              value={form.url}
            />
          </FormField>
        ) : (
          <FormField label="Command">
            <Input
              onChange={(event) =>
                onChange({ ...form, command: event.target.value })
              }
              placeholder="npx"
              value={form.command}
            />
          </FormField>
        )}
      </div>

      {form.protocol === "acp" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField className="sm:col-span-2" label="Arguments">
            <Textarea
              className="min-h-24 font-mono text-xs"
              onChange={(event) =>
                onChange({ ...form, args: event.target.value })
              }
              placeholder={"@zed-industries/codex-acp\n--some-flag"}
              spellCheck={false}
              value={form.args}
            />
            <FieldDescription>
              One argument per line. The gateway passes these to the stdio
              process without shell parsing.
            </FieldDescription>
          </FormField>
          <FormField label="Working Directory">
            <Input
              onChange={(event) =>
                onChange({ ...form, cwd: event.target.value })
              }
              placeholder="Defaults to gateway cwd"
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
          <FormField label="Request Timeout">
            <Input
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

      <FormField label="Description">
        <Textarea
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
  label,
  children,
}: {
  className?: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <ShadcnField className={className}>
      <FieldLabel>{label}</FieldLabel>
      {children}
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
