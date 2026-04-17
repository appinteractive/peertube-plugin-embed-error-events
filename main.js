async function register({ registerSetting }) {
  registerSetting({
    name: 'documentation-info',
    label: 'About this plugin',
    type: 'html',
    descriptionHTML: '<p>This plugin forwards video player errors from the embed iframe to the parent window via <code>postMessage</code>.</p>' +
          '<p>No configuration needed — the plugin works out of the box.</p>' +
          '<p><a href="https://github.com/appinteractive/peertube-plugin-embed-error-events" target="_blank">Documentation &amp; Usage Guide</a></p>',
    private: true
  })
}

async function unregister() {}

module.exports = { register, unregister }
