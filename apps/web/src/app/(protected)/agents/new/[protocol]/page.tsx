import { NewAgentPage } from "../page";

export default async function NewAgentProtocolPage({
  params,
}: {
  params: Promise<{ protocol: string }>;
}) {
  const { protocol } = await params;
  return <NewAgentPage initialProtocol={protocol} key={protocol} />;
}
