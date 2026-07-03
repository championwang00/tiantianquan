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
