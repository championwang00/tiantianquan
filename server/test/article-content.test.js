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
