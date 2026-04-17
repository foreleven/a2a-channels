import * as Lark from "@larksuiteoapi/node-sdk";

const client = new Lark.Client({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
});

const res = await (client.contact.user as any).batch({
  params: {
    user_ids: ["ou_f873ee025f33cd515e2e28e00e8d50be"],
    user_id_type: "open_id",
  },
});

console.log(JSON.stringify(res, null, 2));
