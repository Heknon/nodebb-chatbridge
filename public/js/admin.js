'use strict';

/* global $, config, define, require */

// No dependencies in define(): NodeBB's build can fail to resolve a plugin ACP
// module that declares them (see nodebb-shotef/public/js/admin.js). They are
// loaded with require() in init instead.
define('admin/plugins/chatbridge', [], function () {
	var ACP = {};
	var HASH = 'chatbridge';

	function call(method, path, data) {
		return $.ajax({
			url: config.relative_path + '/api/v3/plugins/chatbridge' + path,
			method: method,
			headers: { 'x-csrf-token': config.csrf_token },
			contentType: data ? 'application/json' : undefined,
			data: data ? JSON.stringify(data) : undefined,
		}).then(function (body) { return (body && body.response) || {}; });
	}

	function esc(s) {
		return $('<span>').text(s == null ? '' : String(s)).html();
	}

	function showResult(provider, ok, text) {
		$('.chatbridge-result[data-provider="' + provider + '"]')
			.removeClass('text-success text-danger')
			.addClass(ok ? 'text-success' : 'text-danger')
			.text(text);
	}

	var OUTCOME_CLASS = { sent: 'text-bg-success', retrying: 'text-bg-warning', failed: 'text-bg-danger', dropped: 'text-bg-secondary', unmatched: 'text-bg-secondary' };

	function loadLog() {
		call('GET', '/log').then(function (r) {
			var rows = (r.entries || []).map(function (e) {
				var topic = e.url ? '<a href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.title || e.url) + '</a>' : esc(e.title);
				// The reason goes under the topic: a column of its own is squeezed
				// off the side of the ACP's narrow card.
				var error = e.error ? '<div class="small text-danger text-break">' + esc(e.error) + '</div>' : '';
				return '<tr><td class="text-nowrap">' + esc(new Date(e.at).toLocaleString()) + '</td>' +
					'<td><span class="badge ' + (OUTCOME_CLASS[e.outcome] || 'text-bg-light') + '">' + esc(e.outcome) + '</span></td>' +
					'<td>' + esc(e.provider) + '</td>' +
					'<td><a href="' + config.relative_path + '/uid/' + esc(e.uid) + '">' + esc(e.uid) + '</a></td>' +
					'<td>' + esc(e.event) + '</td><td>' + topic + error + '</td></tr>';
			});
			$('#chatbridge-log').html(rows.length ? rows.join('') : '<tr><td colspan="6" class="text-muted">Nothing sent yet.</td></tr>');
			$('#chatbridge-pending').text(r.pending ? r.pending + ' message(s) waiting to be retried.' : '');
		}).catch(function () {
			$('#chatbridge-log').html('<tr><td colspan="6" class="text-danger">Could not load the log.</td></tr>');
		});
	}

	// ------------------------------------------------ body template helpers
	// Placeholders come from the provider (ajaxify.data.templateHelp): a
	// dropdown after "{{" (and after "|" for filters), clickable chips, and a
	// live preview of what would be sent.

	// Where the caret is inside a textarea, in px from its top-left, via a
	// mirror element with the same text metrics.
	function caretXY(ta) {
		var cs = window.getComputedStyle(ta);
		var mirror = document.createElement('div');
		['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight',
			'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'tabSize',
		].forEach(function (k) { mirror.style[k] = cs[k]; });
		mirror.style.position = 'absolute';
		mirror.style.visibility = 'hidden';
		mirror.style.whiteSpace = 'pre-wrap';
		mirror.style.wordWrap = 'break-word';
		mirror.textContent = ta.value.slice(0, ta.selectionStart);
		var mark = document.createElement('span');
		mark.textContent = '​';
		mirror.appendChild(mark);
		document.body.appendChild(mirror);
		var xy = { x: mark.offsetLeft - ta.scrollLeft, y: mark.offsetTop - ta.scrollTop + mark.offsetHeight };
		document.body.removeChild(mirror);
		return xy;
	}

	// What is being typed at the caret: a placeholder name after "{{", or a
	// filter after "|" inside one. null elsewhere.
	function typing(text, pos) {
		var before = text.slice(0, pos);
		var open = before.lastIndexOf('{{');
		if (open < 0 || before.lastIndexOf('}}') > open) return null;
		var inner = before.slice(open + 2);
		if (/[\n"]/.test(inner)) return null;
		var pipe = inner.lastIndexOf('|');
		if (pipe >= 0) {
			var f = inner.slice(pipe + 1).replace(/^\s+/, '');
			return /^[a-z]*$/i.test(f) ? { kind: 'filter', query: f, start: pos - f.length } : null;
		}
		var n = inner.replace(/^\s+/, '');
		return /^[\w.:-]*$/.test(n) ? { kind: 'name', query: n, start: pos - n.length } : null;
	}

	function matches(list, query) {
		var q = query.toLowerCase();
		var hits = list.filter(function (it) { return it.name.toLowerCase().indexOf(q) !== -1; });
		return hits.sort(function (a, b) {
			var pa = a.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
			var pb = b.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
			return pa - pb;
		});
	}

	function replaceRange(ta, start, end, text, caret) {
		var v = ta.value;
		ta.value = v.slice(0, start) + text + v.slice(end);
		var at = start + (caret === undefined ? text.length : caret);
		ta.focus();
		ta.setSelectionRange(at, at);
		$(ta).trigger('input');
	}

	function setupTemplateField($ta, help) {
		var ta = $ta[0];
		var $menu = $('<div class="dropdown-menu shadow chatbridge-ac" style="max-height: 16rem; overflow-y: auto; min-width: 18rem;"></div>');
		$ta.after($menu);
		var state = null; // { ctx, items, active }

		function close() { state = null; $menu.removeClass('show').empty(); }

		function choose(i) {
			if (!state || !state.items[i]) return;
			var ctx = state.ctx;
			var name = state.items[i].name;
			var after = ta.value.slice(ta.selectionStart);
			var end = ta.selectionStart + (/^[\w.:-]*/.exec(after) || [''])[0].length; // the rest of a word being replaced
			var closed = /^\s*(\}\}|\|)/.test(ta.value.slice(end));
			close();
			replaceRange(ta, ctx.start, end, name + (closed ? '' : '}}'));
		}

		function render() {
			$menu.empty();
			state.items.forEach(function (it, i) {
				var $it = $('<button type="button" class="dropdown-item d-flex justify-content-between gap-3 py-1"></button>')
					.toggleClass('active', i === state.active)
					.append($('<code class="text-reset"></code>').text(state.ctx.kind === 'filter' ? '|' + it.name : it.name))
					.append($('<span class="small text-truncate"></span>').toggleClass('text-muted', i !== state.active).css('opacity', i === state.active ? 0.85 : '').text(it.help || ''));
				$it.on('mousedown', function (e) { e.preventDefault(); choose(i); });
				$menu.append($it);
			});
			var xy = caretXY(ta);
			$menu.css({ position: 'absolute', left: Math.min(xy.x, Math.max(0, ta.clientWidth - 288)) + 'px', top: (xy.y + 4) + 'px' }).addClass('show');
			var $a = $menu.children().eq(state.active);
			if ($a.length) $a[0].scrollIntoView({ block: 'nearest' });
		}

		function update() {
			var ctx = typing(ta.value, ta.selectionStart);
			if (!ctx || ta.selectionStart !== ta.selectionEnd) return close();
			var items = matches(ctx.kind === 'filter' ? help.filters : help.placeholders, ctx.query);
			if (!items.length) return close();
			state = { ctx: ctx, items: items, active: 0 };
			render();
		}

		$ta.on('input click', update);
		$ta.on('keydown', function (e) {
			if (!state) {
				if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); update(); }
				return;
			}
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				var n = state.items.length;
				state.active = (state.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
				render();
			} else if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				choose(state.active);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				close();
			}
		});
		$ta.on('blur', close);

		// Chips: every placeholder, grouped; click to insert at the caret.
		var groups = {};
		help.placeholders.forEach(function (p) { (groups[p.group] = groups[p.group] || []).push(p); });
		var $chips = $('.chatbridge-chips[data-for="' + $ta.attr('name') + '"]');
		Object.keys(groups).concat(help.filters.length ? ['Filters'] : []).forEach(function (g) {
			var list = g === 'Filters' ? help.filters : groups[g];
			var $row = $('<div class="d-flex flex-wrap align-items-center gap-1 mb-1"></div>')
				.append($('<span class="small text-muted me-1" style="min-width: 6.5rem;"></span>').text(g));
			list.forEach(function (p) {
				var token = g === 'Filters' ? '|' + p.name : '{{' + p.name + '}}';
				$('<button type="button" class="btn btn-light border btn-sm py-0 px-1 font-monospace small"></button>')
					.text(token).attr('title', p.help || '').attr('data-token', token)
					.on('mousedown', function (e) { e.preventDefault(); })
					.on('click', function () {
						var at = ta.selectionStart;
						// A filter goes inside the placeholder the caret is in or just after.
						if (g === 'Filters' && ta.value.slice(at - 2, at) === '}}') at -= 2;
						replaceRange(ta, at, g === 'Filters' ? at : ta.selectionEnd, token);
					})
					.appendTo($row);
			});
			$chips.append($row);
		});
	}

	function setupPreview(provider) {
		var $box = $('.chatbridge-preview[data-provider="' + provider + '"]');
		if (!$box.length) return;
		var $card = $('.card[data-provider="' + provider + '"]');
		var timer = null;
		function run() {
			var values = {};
			$card.find('[name^="' + provider + '_"]').each(function () {
				if (this.type !== 'checkbox') values[this.name] = $(this).val();
			});
			call('POST', '/providers/' + encodeURIComponent(provider) + '/preview', { values: values }).then(function (r) {
				var $out = $box.find('.chatbridge-preview-out');
				var $note = $box.find('.chatbridge-preview-note').removeClass('text-danger text-warning-emphasis');
				if (!r.ok) {
					$out.addClass('text-danger').text(r.error || 'Cannot preview.');
					$note.text('');
					return;
				}
				var lines = ['POST ' + (values[provider + '_url'] || '(no URL)')];
				Object.keys(r.headers || {}).forEach(function (k) { lines.push(k + ': ' + r.headers[k]); });
				$out.removeClass('text-danger').text(lines.join('\n') + '\n\n' + JSON.stringify(r.body, null, 2));
				if (r.missing && r.missing.length) {
					$note.addClass('text-warning-emphasis').text('· You would get nothing: your account has no value for ' + r.missing.join(', ') + '.');
				} else {
					$note.text('');
				}
			}).catch(function () {
				$box.find('.chatbridge-preview-out').addClass('text-danger').text('Preview failed.');
			});
		}
		$card.on('input change', '[name^="' + provider + '_"]', function () {
			clearTimeout(timer);
			timer = setTimeout(run, 350);
		});
		run();
	}

	function setupTemplates() {
		var help = (window.ajaxify && ajaxify.data && ajaxify.data.templateHelp) || {};
		$('textarea[data-placeholders]').each(function () {
			var provider = $(this).attr('data-placeholders');
			if (help[provider]) setupTemplateField($(this), help[provider]);
		});
		Object.keys(help).forEach(function (p) { if (help[p]) setupPreview(p); });
	}

	ACP.init = function () {
		require(['settings', 'alerts'], function (settings, alerts) {
			var $form = $('.chatbridge-settings');
			settings.load(HASH, $form, setupTemplates);

			$('#chatbridge-save').on('click', function (e) {
				e.preventDefault();
				settings.save(HASH, $form, function () {
					alerts.success('Saved.');
				});
			});

			$form.on('click', '.chatbridge-verify', function () {
				var p = $(this).attr('data-provider');
				showResult(p, true, 'Checking…');
				call('POST', '/providers/' + encodeURIComponent(p) + '/verify').then(function (r) {
					if (r.ok && r.message) showResult(p, true, r.message);
					else if (r.ok) showResult(p, true, 'Connected as ' + r.name + (r.isBot ? ' (bot)' : ' (not a bot account)'));
					else showResult(p, false, r.error);
				}).catch(function () { showResult(p, false, 'Request failed.'); });
			});

			$form.on('click', '.chatbridge-test-message', function () {
				var p = $(this).attr('data-provider');
				showResult(p, true, 'Sending…');
				call('POST', '/providers/' + encodeURIComponent(p) + '/test-message').then(function (r) {
					if (r.ok) showResult(p, true, 'Sent. Check your direct messages.');
					else showResult(p, false, r.error);
					loadLog();
				}).catch(function () { showResult(p, false, 'Request failed.'); });
			});

			$('#chatbridge-refresh-log').on('click', loadLog);
			loadLog();
		});
	};

	return ACP;
});
