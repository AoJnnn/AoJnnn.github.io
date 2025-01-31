---
layout: default
---

{% for post in site.posts %}
  <article class="post">
    <h2><a href="{{ post.url }}">{{ post.title }}</a></h2>
    <div class="post-date">{{ post.date | date: "%Y年%m月%d日" }}</div>
    {{ post.excerpt }}
  </article>
{% endfor %}