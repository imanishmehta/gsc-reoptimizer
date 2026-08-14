// Backend for the Content Audit tab's "Apply live" buttons. Holds the
// write-capable Wix Admin API key server-side -- this is the whole reason
// the Worker exists, since GitHub Pages has no server and a write key can
// never sit in client JS. The static page calls this Worker; this Worker
// calls Wix.

const SITES = {
  mimicminds: '1d570b1b-ba44-4cdd-bb4b-176a7afb7d75',
  mimicproductions: '20db1d0f-b8d3-49e6-8100-03577875df69',
};

const ALLOWED_ORIGIN = 'https://imanishmehta.github.io';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function wixFetch(env, siteId, path, options = {}) {
  return fetch(`https://www.wixapis.com${path}`, {
    ...options,
    headers: {
      Authorization: env.WIX_API_KEY,
      'Content-Type': 'application/json',
      'wix-site-id': siteId,
      ...(options.headers || {}),
    },
  });
}

function extractTag(tags, type, propsName) {
  const tag = propsName
    ? tags.find(t => t.type === type && t.props?.name === propsName)
    : tags.find(t => t.type === type);
  return tag ? (tag.children ?? tag.props?.content ?? null) : null;
}

function mergeTags(existingTags, { title, metaDescription }) {
  const tags = existingTags.filter(t => {
    if (title !== undefined && t.type === 'title') return false;
    if (metaDescription !== undefined && t.type === 'meta' && t.props?.name === 'description') return false;
    return true;
  });
  if (title !== undefined) tags.push({ type: 'title', children: title });
  if (metaDescription !== undefined) {
    tags.push({ type: 'meta', props: { name: 'description', content: metaDescription } });
  }
  return tags;
}

async function handleApply(request, env) {
  const body = await request.json();
  const { site, itemType, itemId, title, metaDescription, focusKeywords, password, pageUrl } = body;

  if (password !== env.ACTION_PASSWORD) {
    return json({ error: 'Wrong password' }, 401);
  }
  const siteId = SITES[site];
  if (!siteId) return json({ error: `Unknown site: ${site}` }, 400);
  if (!itemType || !itemId) return json({ error: 'Missing itemType/itemId' }, 400);
  if (title === undefined && metaDescription === undefined && focusKeywords === undefined) {
    return json({ error: 'Nothing to change' }, 400);
  }

  // 1. Read current state so we have a real "previous" snapshot and can
  //    merge into the full tags array (Wix replaces tags in full on write).
  const getRes = await wixFetch(env, siteId, `/promote/seo/v1/item-seo-tags/${itemType}/${itemId}`);
  if (!getRes.ok) {
    return json({ error: `Wix read failed: ${getRes.status} ${await getRes.text()}` }, 502);
  }
  const current = (await getRes.json()).itemSeoTags;
  const existingTags = current.tags || [];
  // resolvedTags is what the page actually renders with (inherited/pattern
  // defaults included) -- only used for an accurate "before" snapshot to
  // show the user; the write below merges into the raw `tags` array, which
  // is correct as-is (an item with no own tags should stay that way except
  // for the field being changed).
  const resolvedFlat = (current.resolvedTags || []).map(rt => rt.tag);

  const previous = {
    title: extractTag(existingTags, 'title') || extractTag(resolvedFlat, 'title'),
    metaDescription: extractTag(existingTags, 'meta', 'description') || extractTag(resolvedFlat, 'meta', 'description'),
    focusKeywords: current.focusKeywords || [],
  };

  // 2. Build the full replacement payload.
  const newTags = mergeTags(existingTags, { title, metaDescription });
  const fieldMaskParts = [];
  if (title !== undefined || metaDescription !== undefined) fieldMaskParts.push('tags');
  if (focusKeywords !== undefined) fieldMaskParts.push('focusKeywords');

  const patchBody = {
    itemSeoTags: {
      tags: newTags,
      ...(focusKeywords !== undefined ? { focusKeywords } : {}),
    },
    fieldMask: fieldMaskParts.join(','),
    publish: true, // static pages: goes straight to the live published revision
  };

  const patchRes = await wixFetch(env, siteId, `/promote/seo/v1/item-seo-tags/${itemType}/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(patchBody),
  });
  if (!patchRes.ok) {
    return json({ error: `Wix write failed: ${patchRes.status} ${await patchRes.text()}` }, 502);
  }
  const updated = (await patchRes.json()).itemSeoTags;

  return json({
    ok: true,
    previous,
    current: {
      title: title !== undefined ? title : previous.title,
      metaDescription: metaDescription !== undefined ? metaDescription : previous.metaDescription,
      focusKeywords: focusKeywords !== undefined ? focusKeywords : previous.focusKeywords,
    },
    pageUrl: pageUrl || null,
    appliedAt: new Date().toISOString(),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true });
    }
    if (url.pathname === '/apply-seo-tags' && request.method === 'POST') {
      try {
        return await handleApply(request, env);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }
    return json({ error: 'Not found' }, 404);
  },
};
