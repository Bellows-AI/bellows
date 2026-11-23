if selected_phase gitlab; then
begin_phase gitlab
# --- The fake GitLab fixture boots and serves what later GitLab phases need ----------------------
#
# A stub: no task runs against GitLab yet. The lane's fake forge (scripts/fake-forge) serves GitLab beside
# GitHub on $LANE_FAKE_FORGE_URL; this phase proves the fixture itself — a signed-in token, a project by its
# URL-encoded nested path, and git smart-HTTP that clones with oauth2:<token> and refuses any other.

echo
echo '# gitlab (fake forge fixture: OAuth, REST v4, git smart-HTTP)'

GITLAB_PROJECT='acme/group/proj'
gitlab_control() { # gitlab_control <path> <json> -> the answer's body
    body "$(BASE="$LANE_FAKE_FORGE_URL" AUTH_HEADER='' api POST "/_control/gitlab/$1" "$2")"
}
gitlab_api() { # gitlab_api <token> <path> -> status TAB body
    BASE="$LANE_FAKE_FORGE_URL" AUTH_HEADER="Bearer $1" api GET "$2"
}

gitlab_seed="$(gitlab_control projects "{\"path\":\"$GITLAB_PROJECT\",\"files\":{\"README.md\":\"hello\"}}")"
expect_contains 'the fixture seeds a project' "$gitlab_seed" "\"path_with_namespace\":\"$GITLAB_PROJECT\""
gitlab_token="$(field "$(gitlab_control sign-in '{"login":"lane-dev"}')" access_token)"
[ -n "$gitlab_token" ] && ok 'a member signs in' || bad 'a member signs in' 'no access_token'

gitlab_project="$(gitlab_api "$gitlab_token" '/api/v4/projects/acme%2Fgroup%2Fproj')"
if [ "$(status "$gitlab_project")" = 200 ]; then
    expect_contains 'the project is found by its encoded nested path' "$(body "$gitlab_project")" "\"path_with_namespace\":\"$GITLAB_PROJECT\""
else
    bad 'the project is found by its encoded nested path' "got $(status "$gitlab_project"): $(body "$gitlab_project")"
fi
[ "$(status "$(gitlab_api bogus-token /api/v4/user)")" = 401 ] && ok 'an unknown token is refused' || bad 'an unknown token is refused' 'not 401'

gitlab_host="${LANE_FAKE_FORGE_URL#http://}"
gitlab_clone="$work/gitlab-clone"
if GIT_TERMINAL_PROMPT=0 git clone -q "http://oauth2:$gitlab_token@$gitlab_host/$GITLAB_PROJECT.git" "$gitlab_clone" >"$work/gitlab-clone.log" 2>&1 &&
    [ "$(cat "$gitlab_clone/README.md")" = hello ]; then
    ok 'git clones with oauth2:<token>'
else
    bad 'git clones with oauth2:<token>' "$(tail -3 "$work/gitlab-clone.log")"
fi
if GIT_TERMINAL_PROMPT=0 git clone -q "http://oauth2:bogus-token@$gitlab_host/$GITLAB_PROJECT.git" "$work/gitlab-refused" >/dev/null 2>&1; then
    bad 'git refuses a token the fake never issued' 'the clone succeeded'
else
    ok 'git refuses a token the fake never issued'
fi
end_phase
fi
