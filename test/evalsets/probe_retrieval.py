"""Phase 1 probe: can embed() retrieve tools from a realistic catalogue?

The question tool-pruning depends on: if we forward only the top-k of N tools,
how often is the tool the model actually needs still in the k?

A synthetic catalogue would flatter it, so this uses a real-shaped one: the
kinds of tools a coding agent actually carries (FS, shell, git, search, DB,
network, build), each with a real description and a real argument signature,
and user turns written the way people actually phrase requests.
"""
from needle import Needle

# (name, description) — the shape embed() actually sees.
CATALOGUE = [
    ("read_file", "Read the contents of a file at an absolute path."),
    ("write_file", "Write text content to a file, creating it if absent."),
    ("edit_file", "Replace an exact string in a file with new content."),
    ("list_directory", "List the entries of a directory."),
    ("search_files", "Search for files matching a glob pattern inside a directory."),
    ("get_file_info", "Get size, type, and modification time of a file."),
    ("move_file", "Move or rename a file or directory."),
    ("copy_file", "Copy a file to a new path."),
    ("delete_file", "Delete a file or directory permanently."),
    ("create_directory", "Create a directory, including parents."),
    ("run_command", "Run a shell command and return stdout, stderr, and exit code."),
    ("list_processes", "List running processes with CPU and memory usage."),
    ("kill_process", "Terminate a process by its pid."),
    ("git_status", "Show the working tree status of the current repository."),
    ("git_diff", "Show the unstaged or staged changes as a patch."),
    ("git_commit", "Record staged changes with a message."),
    ("git_log", "Show recent commit history."),
    ("git_checkout", "Switch branches, or restore a path from a commit."),
    ("git_push", "Push local commits to the remote."),
    ("git_pull", "Fetch and merge from the remote."),
    ("grep_code", "Search the contents of files for a regular expression."),
    ("find_references", "Find where a symbol is defined and used."),
    ("list_open_tabs", "List the editor's open tabs."),
    ("http_request", "Perform an HTTP request and return status and body."),
    ("fetch_url", "Fetch a URL and return its readable text content."),
    ("send_email", "Send an email message to a recipient."),
    ("create_calendar_event", "Create a calendar event with a start and end time."),
    ("query_database", "Run a SQL query against the configured database."),
    ("list_tables", "List the tables in the connected database."),
    ("install_package", "Install a package with the system package manager."),
    ("run_tests", "Run the project test suite and report results."),
    ("build_project", "Build the project and return compiler output."),
    ("format_code", "Format source files with the project formatter."),
    ("lint_code", "Run the linter and return diagnostics."),
    ("get_weather", "Get the current weather for a city."),
    ("translate_text", "Translate text into a target language."),
    ("summarize_text", "Summarize a block of text."),
    ("generate_image", "Generate an image from a text prompt."),
    ("read_pdf", "Extract the text content of a PDF file."),
    ("convert_file", "Convert a file between formats."),
    ("take_screenshot", "Capture a screenshot of the screen."),
    ("playwright_navigate", "Open a URL in a headless browser."),
    ("click_element", "Click an element identified by a selector."),
    ("type_text", "Type text into the focused element."),
    ("get_page_text", "Read the visible text of the current page."),
]

# (user turn, the tool that is actually needed)
TURNS = [
    ("show me what's in the src directory", "list_directory"),
    ("open /etc/passwd and show me the contents", "read_file"),
    ("put the string 'hello' into a file called /tmp/a.txt", "write_file"),
    ("change the word foo to bar in main.py", "edit_file"),
    ("find every .ts file under src", "search_files"),
    ("how big is the video.mp4 file?", "get_file_info"),
    ("rename old.txt to new.txt", "move_file"),
    ("duplicate config.json to config.bak.json", "copy_file"),
    ("wipe out build/ entirely", "delete_file"),
    ("make a folder called outputs", "create_directory"),
    ("run the tests with npm", "run_command"),
    ("what processes are eating my CPU?", "list_processes"),
    ("which branch am i on and what changed?", "git_status"),
    ("show me the diff of my working tree", "git_diff"),
    ("commit these as 'fix parser'", "git_commit"),
    ("what did you commit last week?", "git_log"),
    ("switch to the develop branch", "git_checkout"),
    ("search the codebase for TODO comments", "grep_code"),
    ("where is the User class defined?", "find_references"),
    ("call the /api/v1/users endpoint", "http_request"),
    ("get the contents of that documentation page", "fetch_url"),
    ("email bob the quarterly report", "send_email"),
    ("book a meeting for thursday at 3pm", "create_calendar_event"),
    ("select the top 10 rows from the orders table", "query_database"),
    ("pip install requests", "install_package"),
    ("npm test", "run_tests"),
    ("compile the project", "build_project"),
    ("run prettier over the codebase", "format_code"),
    ("any lint errors?", "lint_code"),
    ("what's the weather in Tokyo?", "get_weather"),
    ("translate this into German", "translate_text"),
    ("give me a short summary of this article", "summarize_text"),
    ("make me a picture of a mountain at sunset", "generate_image"),
    ("pull the text out of this scanned PDF", "read_pdf"),
    ("turn this png into a jpeg", "convert_file"),
    ("grab a screenshot of the desktop", "take_screenshot"),
    ("browse to example.com", "playwright_navigate"),
    ("click the submit button", "click_element"),
    ("fill in the search box with 'shoes'", "type_text"),
    ("scrape the text off the current page", "get_page_text"),
]


def main() -> None:
    engine = Needle(stateless=True)
    tool_vectors = [(n, engine.embed(f"{n}: {d}")) for n, d in CATALOGUE]

    ks = (5, 10, 20)
    hits = {k: 0 for k in ks}
    ranks = []
    for turn, want in TURNS:
        qv = engine.embed(turn)
        scored = sorted(
            ((sum(a * b for a, b in zip(qv, tv)), n) for n, tv in tool_vectors),
            reverse=True,
        )
        order = [n for _, n in scored]
        rank = order.index(want) + 1
        ranks.append(rank)
        for k in ks:
            if rank <= k:
                hits[k] += 1
        print("rank=%-3d %-24s %r" % (rank, want, turn[:44]))

    n = len(TURNS)
    print()
    for k in ks:
        print("recall@%-3d %5.1f%%  (%d/%d)" % (k, 100.0 * hits[k] / n, hits[k], n))
    print("median rank: %d" % sorted(ranks)[len(ranks) // 2])
    print("misses (rank > 20): %s" % [t[1] for t, r in zip(TURNS, ranks) if r > 20])


if __name__ == "__main__":
    main()
