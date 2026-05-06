import { NewChannelBindingPage } from "../page";

export default async function NewChannelBindingChannelPage({
  params,
}: {
  params: Promise<{ channelType: string }>;
}) {
  const { channelType } = await params;
  return (
    <NewChannelBindingPage
      initialChannelType={channelType}
      key={channelType}
    />
  );
}
