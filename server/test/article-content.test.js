import assert from "node:assert/strict";
import test from "node:test";
import { articleHtmlToMarkdown, extractArticleImageUrls } from "../src/utils/article.js";

test("converts structured article HTML to markdown in source order", () => {
  const html = `
    <article>
      <nav>Previous | Next</nav>
      <h2>Field notes</h2>
      <p>Read the <a href="/guide">full guide</a>.</p>
      <img src="images/camp.jpg" alt="Camp at dusk">
      <ul><li>Water</li><li><em>Warm</em> layer</li></ul>
      <footer>Copyright noise</footer>
      <script>alert("noise")</script>
    </article>`;

  assert.equal(
    articleHtmlToMarkdown(html, "https://example.com/journal/day-one"),
    "## Field notes\n\nRead the [full guide](https://example.com/guide).\n\n![Camp at dusk](https://example.com/journal/images/camp.jpg)\n\n- Water\n- *Warm* layer"
  );
});

test("supports quotes, ordered lists, fenced code, strong text, and unique image extraction", () => {
  const markdown = articleHtmlToMarkdown(`
    <main>
      <blockquote><p>A <strong>useful</strong> note.</p></blockquote>
      <ol><li>First</li><li>Second</li></ol>
      <pre><code class="language-js">const x = 1;</code></pre>
      <p><img src="/a.png"><img src="/a.png"><img src="https://cdn.example/b.jpg"></p>
    </main>`, "https://example.com/post");

  assert.match(markdown, /> A \*\*useful\*\* note\./);
  assert.match(markdown, /1\. First\n2\. Second/);
  assert.match(markdown, /```js\nconst x = 1;\n```/);
  assert.deepEqual(extractArticleImageUrls(markdown), [
    "https://example.com/a.png",
    "https://cdn.example/b.jpg"
  ]);
});

test("converts article tables to markdown tables", () => {
  const markdown = articleHtmlToMarkdown(`
    <article>
      <table>
        <tr><th>Loop</th><th>Handoff</th><th>Use when</th></tr>
        <tr><td>Turn-based</td><td>Check</td><td>Exploring | deciding</td></tr>
        <tr><td>Dynamic</td><td><a href="/workflow">Workflow</a></td><td>Long<br>running</td></tr>
      </table>
    </article>`, "https://example.com/post");

  assert.equal(markdown, [
    "| Loop | Handoff | Use when |",
    "| --- | --- | --- |",
    "| Turn-based | Check | Exploring \\| deciding |",
    "| Dynamic | [Workflow](https://example.com/workflow) | Long<br>running |"
  ].join("\n"));
});

test("adds synthetic headers when an article table has no th row", () => {
  const markdown = articleHtmlToMarkdown(`
    <article>
      <table>
        <tr><td>A</td><td>B</td></tr>
        <tr><td>C</td><td>D</td></tr>
      </table>
    </article>`, "https://example.com/post");

  assert.equal(markdown, [
    "| 列 1 | 列 2 |",
    "| --- | --- |",
    "| A | B |",
    "| C | D |"
  ].join("\n"));
});

test("rejects unsafe link and image protocols", () => {
  const markdown = articleHtmlToMarkdown(`
    <article>
      <p><a href="file:///tmp/secret">file</a> <a href="ftp://example.com/a">ftp</a>
      <a href="custom:open">custom</a> <a href="javascript:alert(1)">js</a></p>
      <img src="data:image/png;base64,x"><img src="blob:https://example.com/id">
      <img src="/safe.png"><a href="https://example.com/safe">safe</a>
    </article>`, "https://example.com/post");

  assert.equal(markdown, "file ftp custom js\n\n![](https://example.com/safe.png)\n\n[safe](https://example.com/safe)");
});

test("extracts only absolute http and https image URLs", () => {
  assert.deepEqual(extractArticleImageUrls(`
    ![safe](https://example.com/a.png)
    ![also safe](http://example.com/b.jpg)
    ![file](file:///tmp/c.png)
    ![ftp](ftp://example.com/d.png)
    ![custom](app:asset)
    ![relative](/e.png)
    ![script](javascript:alert)
  `), ["https://example.com/a.png", "http://example.com/b.jpg"]);
});

test("preserves and extracts image URLs containing parentheses", () => {
  const markdown = articleHtmlToMarkdown(
    '<article><img src="https://example.com/a_(b).png" alt="diagram"></article>',
    "https://example.com/post"
  );

  assert.equal(markdown, "![diagram](<https://example.com/a_(b).png>)");
  assert.deepEqual(extractArticleImageUrls(markdown), ["https://example.com/a_(b).png"]);
});

test("converts lazy and responsive article images for Obsidian localization", () => {
  const markdown = articleHtmlToMarkdown(`
    <article>
      <picture>
        <source srcset="/small.webp 640w, /large.webp 1400w">
        <img src="/placeholder.gif" alt="Hero">
      </picture>
      <img data-srcset="/inline-small.jpg 400w, /inline-large.jpg 1200w" alt="Inline">
      <img data-lazy-src="/lazy.png" alt="Lazy">
      <img data-original="/original.jpg" alt="Original">
    </article>`, "https://example.com/posts/one");

  assert.deepEqual(extractArticleImageUrls(markdown), [
    "https://example.com/large.webp",
    "https://example.com/inline-large.jpg",
    "https://example.com/lazy.png",
    "https://example.com/original.jpg"
  ]);
  assert.doesNotMatch(markdown, /placeholder\.gif/);
});

test("preserves commas inside Substack CDN srcset URLs", () => {
  const small = "https://substackcdn.com/image/fetch/$s_!QxIf!,w_424,c_limit,f_auto,q_auto:good/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fexample.jpeg";
  const large = "https://substackcdn.com/image/fetch/$s_!QxIf!,w_1456,c_limit,f_auto,q_auto:good/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fexample.jpeg";
  const markdown = articleHtmlToMarkdown(`
    <article>
      <img src="${large}" srcset="${small} 424w, ${large} 1456w" alt="Substack image">
    </article>`, "https://syntaxstream.substack.com/p/example");

  assert.equal(markdown, `![Substack image](${large})`);
});

test("does not wrap article images in their source-page jump links", () => {
  const image = "https://substackcdn.com/image/fetch/example/image.jpeg";
  const markdown = articleHtmlToMarkdown(`
    <article>
      <a href="${image}"><img src="${image}" alt="Diagram"></a>
    </article>`, "https://syntaxstream.substack.com/p/example");

  assert.equal(markdown, `![Diagram](${image})`);
});

test("converts WeChat lazy images inside preview links to markdown images", () => {
  const markdown = articleHtmlToMarkdown(`
    <div id="js_content">
      <p>公众号正文</p>
      <p>
        <a href="https://mp.weixin.qq.com/s/preview-jump">
          <img
            class="rich_pages wxw-img"
            data-src="https://mmbiz.qpic.cn/mmbiz_png/example/640?wx_fmt=png&amp;from=appmsg"
            data-croporisrc="https://mmbiz.qpic.cn/mmbiz_png/example/original?wx_fmt=png"
            src="data:image/gif;base64,R0lGODlhAQABAAAAACw="
            alt="流程图">
        </a>
      </p>
    </div>`, "https://mp.weixin.qq.com/s/SZlk8j1PVTmo9HhCzk-ZhQ");

  assert.equal(markdown, [
    "公众号正文",
    "",
    "![流程图](https://mmbiz.qpic.cn/mmbiz_png/example/640?wx_fmt=png&from=appmsg)"
  ].join("\n"));
  assert.deepEqual(extractArticleImageUrls(markdown), [
    "https://mmbiz.qpic.cn/mmbiz_png/example/640?wx_fmt=png&from=appmsg"
  ]);
});

test("escapes hostile markdown text and uses code delimiters longer than content", () => {
  const markdown = articleHtmlToMarkdown(`
    <article>
      <h2># [Heading] *raw*</h2>
      <p>Text _with_ [brackets] and <a href="/safe">label ] * x</a>.</p>
      <img src="/image.png" alt="alt ] * raw">
      <p><code>a ${"``"} b</code></p>
      <pre><code class="language-js">const ticks = ${"```"};</code></pre>
    </article>`, "https://example.com/post");

  assert.ok(markdown.includes("## \\# \\[Heading\\] \\*raw\\*"));
  assert.ok(markdown.includes("Text \\_with\\_ \\[brackets\\]"));
  assert.ok(markdown.includes("[label \\] \\* x](https://example.com/safe)"));
  assert.ok(markdown.includes("![alt \\] \\* raw](https://example.com/image.png)"));
  assert.ok(markdown.includes("```a `` b```"));
  assert.ok(markdown.includes("````js\nconst ticks = ```;\n````"));
});
