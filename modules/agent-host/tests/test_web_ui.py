import unittest

import web_ui


class WebUiTests(unittest.TestCase):
    def test_render_index_html_escapes_project_names(self):
        page = web_ui.render_index_html(["demo", "<unsafe>&project"])

        self.assertIn("&lt;unsafe&gt;&amp;project", page)
        self.assertNotIn('<option value="<unsafe>&project">', page)
        self.assertIn('id="project"', page)
        self.assertIn("Recent Tasks", page)
        self.assertIn("Live Logs", page)
        self.assertIn("/whoami", page)


if __name__ == "__main__":
    unittest.main()
