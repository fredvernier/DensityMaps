import globals from "globals";
import pluginJs from "@eslint/js";


/** @type {import('eslint').Linter.Config[]} */
export default [
  pluginJs.configs.recommended,
   
        {
            name: "client-setup",
            files: ["client/**/*.js"],
            languageOptions: { globals: globals.browser },
            rules: {
            }
        },
        {
            name: "server-config",
            files: ["server/**/*.js"],
            languageOptions: { globals: globals.node },
        }
    ];
  

 /* {languageOptions: { globals: globals.browser }},
  pluginJs.configs.recommended,*/
//];
