export interface Env {
  NOTION_TOKEN: string;
  NOTION_DATA_SOURCE_ID: string;
}

const NOTION_VERSION = "2026-03-11";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch (e) {
      return jsonError(400, "invalid multipart body", (e as Error).message);
    }

    const audio = form.get("audio");
    const date = form.get("date");

    if (!(audio instanceof File)) {
      return jsonError(400, "missing or invalid 'audio' file field");
    }
    if (typeof date !== "string" || !date) {
      return jsonError(400, "missing 'date' text field");
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
    };
    const filename = `Home Log ${date}.m4a`;

    // 1. Create file upload object
    const createRes = await fetch("https://api.notion.com/v1/file_uploads", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ filename, content_type: "audio/mp4" }),
    });
    if (!createRes.ok) {
      return jsonError(createRes.status, "create file_upload failed", await createRes.text());
    }
    const createJson = await createRes.json<{ id: string }>();
    const fileUploadId = createJson.id;

    // 2. Send file bytes with Content-Type rewritten to audio/mp4
    const audioBytes = await audio.arrayBuffer();
    const uploadForm = new FormData();
    uploadForm.append(
      "file",
      new Blob([audioBytes], { type: "audio/mp4" }),
      filename,
    );

    const sendRes = await fetch(
      `https://api.notion.com/v1/file_uploads/${fileUploadId}/send`,
      {
        method: "POST",
        headers, // omit Content-Type — fetch adds multipart boundary
        body: uploadForm,
      },
    );
    if (!sendRes.ok) {
      return jsonError(sendRes.status, "send file_upload failed", await sendRes.text());
    }

    // 3. Create page with file_upload attached
    const pageRes = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: {
          type: "data_source_id",
          data_source_id: env.NOTION_DATA_SOURCE_ID,
        },
        properties: {
          Date: {
            title: [{ text: { content: date } }],
          },
          Note: {
            rich_text: [{ text: { content: "" } }],
          },
          Audio: {
            files: [
              {
                type: "file_upload",
                file_upload: { id: fileUploadId },
                name: filename,
              },
            ],
          },
        },
      }),
    });
    if (!pageRes.ok) {
      return jsonError(pageRes.status, "create page failed", await pageRes.text());
    }
    const page = await pageRes.json<{ id: string; url: string }>();

    return Response.json({ ok: true, page_id: page.id, url: page.url });
  },
};

function jsonError(status: number, message: string, detail?: string): Response {
  return Response.json({ ok: false, error: message, detail }, { status });
}
